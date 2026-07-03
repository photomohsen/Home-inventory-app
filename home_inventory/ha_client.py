"""
ha_client.py — Home Assistant connectivity for the NFC scan pipeline.

Mode is decided ONCE at import time:

  prod    : SUPERVISOR_TOKEN env present (running as a HA add-on) ->
            REST  http://supervisor/core/api
            WS    ws://supervisor/core/websocket
            auth  Bearer SUPERVISOR_TOKEN
            Requires `homeassistant_api: true` in config.yaml (and
            `hassio_api: true` for the /addons/self/info ingress-entry lookup).
  dev     : HA_URL + HA_TOKEN available (env, falling back to ../.env) ->
            direct connection, SSL verification DISABLED (self-signed cert).
  offline : neither is available, OR INVENTORY_NO_HA=1 ->
            every function no-ops gracefully: ha_available() is False,
            ha_tags() returns [], notify() only logs. The app must never
            crash or block because HA is unreachable.

Env switches:
  INVENTORY_NO_HA=1          force offline mode (tests / pure-local dev).
  INVENTORY_NO_NOTIFY=1      suppress notification sending (still logged).
  INVENTORY_NOTIFY_SERVICE   fallback notify service (e.g. mobile_app_x or
                             notify.mobile_app_x) when the scanning device
                             can't be resolved from the device registry.
"""

import itertools
import json
import logging
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.request

log = logging.getLogger("ha_client")

try:
    import websocket  # websocket-client
except ImportError:  # pragma: no cover — listed in requirements.txt
    websocket = None

_TRUTHY = {"1", "true", "yes", "on"}

NO_HA = os.environ.get("INVENTORY_NO_HA", "").strip().lower() in _TRUTHY
NO_NOTIFY = os.environ.get("INVENTORY_NO_NOTIFY", "").strip().lower() in _TRUTHY

WS_TIMEOUT = 10          # seconds — one-shot commands
REST_TIMEOUT = 8         # seconds
LISTENER_IDLE_PING = 55  # seconds of recv silence before we ping
BACKOFF_CAP = 60         # seconds — reconnect backoff ceiling
DEVICE_CACHE_TTL = 300   # seconds — device registry cache

# Message ids for the HA websocket protocol. HA only requires ids to increase
# within one connection; a shared increasing counter satisfies that everywhere.
_MSG_ID = itertools.count(1)


def _load_dotenv_fallback() -> dict:
    """Read KEY=VALUE pairs from ../.env (the HA project .env) if present."""
    env_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", ".env"
    )
    vals = {}
    try:
        with open(env_path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                vals[key.strip()] = val.strip().strip('"').strip("'")
    except OSError:
        pass
    return vals


def _decide_mode():
    """Return (mode, rest_base, ws_url, token, ssl_verify)."""
    if NO_HA:
        return "offline", None, None, None, True
    supervisor_token = os.environ.get("SUPERVISOR_TOKEN")
    if supervisor_token:
        return ("prod", "http://supervisor/core/api",
                "ws://supervisor/core/websocket", supervisor_token, True)
    ha_url = os.environ.get("HA_URL")
    ha_token = os.environ.get("HA_TOKEN")
    if not (ha_url and ha_token):
        dotenv = _load_dotenv_fallback()
        ha_url = ha_url or dotenv.get("HA_URL")
        ha_token = ha_token or dotenv.get("HA_TOKEN")
    if ha_url and ha_token:
        base = ha_url.rstrip("/")
        ws_url = re.sub(r"^http", "ws", base) + "/api/websocket"
        return "dev", base + "/api", ws_url, ha_token, False
    return "offline", None, None, None, True


MODE, REST_BASE, WS_URL, TOKEN, SSL_VERIFY = _decide_mode()


def ha_available() -> bool:
    """True when we have a way to reach Home Assistant."""
    return MODE != "offline"


# ---------------------------------------------------------------------------
# REST (urllib — no extra deps)
# ---------------------------------------------------------------------------

def _ssl_context(url: str):
    if url.startswith("https") and not SSL_VERIFY:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return None


def _rest(path: str, payload=None, timeout=REST_TIMEOUT):
    """GET (payload None) or POST (payload dict) REST_BASE+path. May raise."""
    url = REST_BASE + path
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout,
                                context=_ssl_context(url)) as resp:
        body = resp.read().decode("utf-8", "replace")
    return json.loads(body) if body.strip() else None


def call_service(domain: str, service: str, data=None):
    """
    POST /api/services/<domain>/<service> (prod: /core/api/services/...).
    Returns the parsed response, or None on any failure / offline. Never raises.
    """
    if MODE == "offline":
        log.info("call_service skipped (offline): %s.%s", domain, service)
        return None
    try:
        return _rest(f"/services/{domain}/{service}", payload=data or {})
    except Exception as exc:
        log.warning("call_service %s.%s failed: %s", domain, service, exc)
        return None


# ---------------------------------------------------------------------------
# Websocket one-shots (fresh short-lived connection per command)
# ---------------------------------------------------------------------------

def _ws_open(timeout=WS_TIMEOUT):
    """Connect + authenticate. Returns the socket. Raises on failure."""
    sslopt = None
    if WS_URL.startswith("wss") and not SSL_VERIFY:
        sslopt = {"cert_reqs": ssl.CERT_NONE, "check_hostname": False}
    ws = websocket.create_connection(WS_URL, timeout=timeout, sslopt=sslopt)
    try:
        first = json.loads(ws.recv())
        if first.get("type") == "auth_required":
            ws.send(json.dumps({"type": "auth", "access_token": TOKEN}))
            reply = json.loads(ws.recv())
            if reply.get("type") != "auth_ok":
                raise RuntimeError(f"HA websocket auth failed: {reply!r}")
        return ws
    except Exception:
        try:
            ws.close()
        except Exception:
            pass
        raise


def ws_cmd(payload: dict, timeout=WS_TIMEOUT):
    """
    One-shot websocket command on a fresh connection: auth, send, await the
    matching result, close. Returns the 'result' value, or None on any
    failure / offline. Never raises.
    """
    if MODE == "offline":
        return None
    if websocket is None:
        log.warning("websocket-client not installed — ws_cmd unavailable")
        return None
    ws = None
    try:
        ws = _ws_open(timeout)
        msg_id = next(_MSG_ID)
        msg = dict(payload)
        msg["id"] = msg_id
        ws.send(json.dumps(msg))
        deadline = time.time() + timeout
        while time.time() < deadline:
            reply = json.loads(ws.recv())
            if reply.get("id") == msg_id and reply.get("type") == "result":
                if reply.get("success"):
                    return reply.get("result")
                log.warning("ws_cmd %s rejected: %s",
                            payload.get("type"), reply.get("error"))
                return None
        log.warning("ws_cmd %s timed out", payload.get("type"))
        return None
    except Exception as exc:
        log.warning("ws_cmd %s failed: %s", payload.get("type"), exc)
        return None
    finally:
        if ws is not None:
            try:
                ws.close()
            except Exception:
                pass


def ha_tags() -> list:
    """
    Tags registered in HA: [{'id','name','last_scanned'}]. [] when offline
    or unreachable.
    """
    res = ws_cmd({"type": "tag/list"})
    if not isinstance(res, list):
        return []
    out = []
    for t in res:
        if not isinstance(t, dict):
            continue
        out.append({
            "id": t.get("id") or t.get("tag_id"),
            "name": t.get("name") or "",
            "last_scanned": t.get("last_scanned"),
        })
    return out


# ---------------------------------------------------------------------------
# Device registry -> display names + notify service guesses
# ---------------------------------------------------------------------------

_device_cache = {"at": 0.0, "by_id": {}}
_device_lock = threading.Lock()


def _device_map() -> dict:
    """device_id -> {'name','name_by_user'} from HA, cached DEVICE_CACHE_TTL s."""
    with _device_lock:
        fresh = (time.time() - _device_cache["at"]) < DEVICE_CACHE_TTL
        if _device_cache["by_id"] and fresh:
            return _device_cache["by_id"]
    res = ws_cmd({"type": "config/device_registry/list"})
    by_id = {}
    if isinstance(res, list):
        for d in res:
            if isinstance(d, dict) and d.get("id"):
                by_id[d["id"]] = {
                    "name": d.get("name") or "",
                    "name_by_user": d.get("name_by_user") or "",
                }
    with _device_lock:
        if by_id:
            _device_cache["by_id"] = by_id
            _device_cache["at"] = time.time()
        return _device_cache["by_id"]


def device_display_name(device_id):
    """Human name of a registry device ('Mohsen S24 Ultra'), or None."""
    if not device_id or MODE == "offline":
        return None
    dev = _device_map().get(device_id)
    if not dev:
        return None
    return dev["name_by_user"] or dev["name"] or None


def _slug(name: str) -> str:
    """HA mobile_app slug: lowercase, runs of non-alphanumerics -> '_'."""
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def _fallback_notify_service():
    svc = (os.environ.get("INVENTORY_NOTIFY_SERVICE") or "").strip()
    if not svc:
        return None
    return svc[len("notify."):] if svc.startswith("notify.") else svc


def notify_service_for_device(device_id):
    """
    Map the scanning device to a companion-app notify service name (without
    the 'notify.' domain), e.g. 'mobile_app_mohsen_s24_ultra'. Tries the
    registry name_by_user first, then name; unknown device -> the
    INVENTORY_NOTIFY_SERVICE env fallback, else None.
    """
    if device_id and MODE != "offline":
        dev = _device_map().get(device_id)
        if dev:
            for candidate in (dev["name_by_user"], dev["name"]):
                if candidate:
                    return f"mobile_app_{_slug(candidate)}"
    return _fallback_notify_service()


def notify(title: str, message: str, url=None, device_id=None) -> None:
    """
    Fire-and-forget companion-app notification (sent from a daemon thread so
    the scan pipeline never blocks on HA). Failures are logged, never raised.
    `url` becomes both `data.url` (iOS) and `data.clickAction` (Android).
    """
    if NO_NOTIFY:
        log.info("notify suppressed (INVENTORY_NO_NOTIFY): %s | %s -> %s",
                 title, message, url)
        return
    if MODE == "offline":
        log.info("notify (offline, log only): %s | %s -> %s",
                 title, message, url)
        return

    def _send():
        try:
            service = notify_service_for_device(device_id)
            if not service:
                log.info("notify skipped — no notify service for device %r "
                         "(set INVENTORY_NOTIFY_SERVICE): %s", device_id, title)
                return
            payload = {"title": title, "message": message}
            if url:
                payload["data"] = {"url": url, "clickAction": url}
            call_service("notify", service, payload)
        except Exception:  # belt & braces — call_service already never raises
            log.warning("notify failed", exc_info=True)

    threading.Thread(target=_send, daemon=True, name="ha-notify").start()


# ---------------------------------------------------------------------------
# Ingress entry — URL prefix for notification links
# ---------------------------------------------------------------------------

_ingress_entry = None  # cached after first successful prod fetch


def link_base() -> str:
    """
    URL prefix for notification links, always ending in '/'. Dev/offline:
    the local server. Prod: the add-on's ingress entry from Supervisor
    (needs hassio_api: true), e.g. '/api/hassio_ingress/<token>/' — the
    companion app resolves relative URLs against the HA instance.
    """
    global _ingress_entry
    if MODE != "prod":
        return "http://localhost:8099/"
    if _ingress_entry is not None:
        return _ingress_entry
    try:
        req = urllib.request.Request(
            "http://supervisor/addons/self/info",
            headers={"Authorization": f"Bearer {os.environ['SUPERVISOR_TOKEN']}"},
        )
        with urllib.request.urlopen(req, timeout=REST_TIMEOUT) as resp:
            info = json.loads(resp.read().decode("utf-8", "replace"))
        entry = ((info or {}).get("data") or {}).get("ingress_entry") or ""
        if entry:
            _ingress_entry = entry.rstrip("/") + "/"
            return _ingress_entry
        log.warning("addons/self/info returned no ingress_entry")
    except Exception as exc:
        log.warning("could not fetch ingress entry: %s", exc)
    return "/"  # degrade to HA root; do not cache the failure


# ---------------------------------------------------------------------------
# Background tag_scanned listener
# ---------------------------------------------------------------------------

_listener_started = False
_listener_lock = threading.Lock()


def start_listener(callback):
    """
    Start the background daemon thread that subscribes to HA `tag_scanned`
    events and invokes callback(tag_id, device_id) for each scan. Safe to
    call once at startup: no-ops when offline, never raises, never blocks.
    Returns the Thread, or None when not started.
    """
    global _listener_started
    if MODE == "offline":
        log.info("HA offline — NFC tag listener not started")
        return None
    if websocket is None:
        log.warning("websocket-client not installed — NFC tag listener disabled")
        return None
    with _listener_lock:
        if _listener_started:
            return None
        _listener_started = True
    thread = threading.Thread(
        target=_listen_forever, args=(callback,),
        daemon=True, name="ha-tag-listener",
    )
    thread.start()
    return thread


def _listen_forever(callback):
    """Connect, subscribe, dispatch; reconnect with exponential backoff."""
    backoff = 1
    while True:
        ws = None
        try:
            ws = _ws_open(timeout=15)
            sub_id = next(_MSG_ID)
            ws.send(json.dumps({
                "id": sub_id, "type": "subscribe_events",
                "event_type": "tag_scanned",
            }))
            # Idle timeout drives our keep-alive ping below.
            ws.settimeout(LISTENER_IDLE_PING)
            log.info("HA tag listener connected (%s mode)", MODE)
            backoff = 1
            while True:
                try:
                    raw = ws.recv()
                except websocket.WebSocketTimeoutException:
                    # Quiet line — verify it is still alive.
                    ws.send(json.dumps({"id": next(_MSG_ID), "type": "ping"}))
                    continue
                if not raw:
                    raise ConnectionError("websocket closed by peer")
                msg = json.loads(raw)
                if msg.get("type") == "event" and msg.get("id") == sub_id:
                    data = (msg.get("event") or {}).get("data") or {}
                    tag_id = data.get("tag_id")
                    device_id = data.get("device_id")
                    if not tag_id:
                        continue
                    log.info("tag_scanned: %s (device %s)", tag_id, device_id)
                    try:
                        callback(tag_id, device_id)
                    except Exception:
                        log.exception("tag scan callback failed for %s", tag_id)
                # result/pong/other frames are ignored.
        except Exception as exc:
            log.warning("HA tag listener disconnected: %s — reconnecting in %ss",
                        exc, backoff)
        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
        time.sleep(backoff)
        backoff = min(backoff * 2, BACKOFF_CAP)
