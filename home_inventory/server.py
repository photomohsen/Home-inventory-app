"""
server.py — Home Inventory backend (Flask, served by waitress).

Responsibilities:
  - Static SPA serving with <base href> injection for HA Ingress.
  - Source-IP allowlist + DEV-mode gating (ADDENDA §2).
  - Full REST API (BUILD_SPEC §5) + admin reset/clear (ADDENDA §4).
  - Image upload + Pillow 256px thumbnails; image serving.
  - Best-effort Open Food Facts v2 lookup proxy (never errors the client).
  - First-run seeding (db.seed_if_empty).
  - NFC: tag registry CRUD + the scan pipeline (handle_tag_scan). Scans arrive
    from the HA `tag_scanned` event via the ha_client websocket listener
    (started in __main__) or from POST /api/nfc/scan (frontend QR-fallback /
    dev simulation).

Run modes (env INVENTORY_DEV truthy => DEV):
  DEV : DATA_DIR=<script dir>/data, no IP allowlist, base href "./", user "Dev User".
  PROD: DATA_DIR=/data, enforce 172.30.32.2, base from X-Ingress-Path, user from
        X-Remote-User-Display-Name -> X-Remote-User-Name -> "unknown".

Bind: waitress 0.0.0.0:8099 threads=8 in both modes.
"""

import io
import json
import logging
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

# Ensure this file's own directory is importable so the sibling modules (db,
# normalize) resolve regardless of how Python is launched — needed under local
# safe-path mode (PYTHONSAFEPATH) and harmless in the add-on's /app WORKDIR.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from flask import Flask, request, jsonify, Response, abort, send_file

from PIL import Image

import db
import ha_client
from normalize import normalize

# ---------------------------------------------------------------------------
# Configuration / mode
# ---------------------------------------------------------------------------

APP_DIR = os.path.dirname(os.path.abspath(__file__))
WWW_DIR = os.path.join(APP_DIR, "www")

_DEV_TRUTHY = {"1", "true", "yes", "on"}
DEV_MODE = os.environ.get("INVENTORY_DEV", "").strip().lower() in _DEV_TRUTHY

if DEV_MODE:
    # INVENTORY_DATA_DIR (DEV only) points tests at an isolated copy of the DB.
    DATA_DIR = (os.environ.get("INVENTORY_DATA_DIR", "").strip()
                or os.path.join(APP_DIR, "data"))
else:
    DATA_DIR = "/data"

DB_PATH = os.path.join(DATA_DIR, "inventory.db")
IMAGES_DIR = os.path.join(DATA_DIR, "images")

INGRESS_ALLOWED_IP = "172.30.32.2"
THUMB_MAX_EDGE = 256
OFF_TIMEOUT = 4  # seconds — short so an offline box degrades fast
OFF_UA = "HomeInventory/2.0 (Home Assistant add-on; https://github.com/photomohsen/Home-inventory-app)"

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(IMAGES_DIR, exist_ok=True)

app = Flask(__name__, static_folder=None)
# Cap request bodies (DoS guard): the largest legitimate request is a photo
# upload. 12 MiB comfortably covers a phone JPEG/PNG; anything larger -> 413.
app.config["MAX_CONTENT_LENGTH"] = 12 * 1024 * 1024


# ---------------------------------------------------------------------------
# Request-parsing helpers (defensive: never let bad input become a 500)
# ---------------------------------------------------------------------------

def json_body():
    """Return the request body only if it is a JSON object, else None."""
    b = request.get_json(silent=True)
    return b if isinstance(b, dict) else None


def as_int(v, default):
    """Coerce v to int, falling back to default on bad/missing input."""
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# DB helpers (one connection per request; sqlite3 is not threadsafe to share)
# ---------------------------------------------------------------------------

def get_db() -> sqlite3.Connection:
    """Open a fresh connection for the current operation."""
    return db.connect(DB_PATH)


def init_db() -> None:
    """Create schema and seed on first run (idempotent)."""
    conn = get_db()
    try:
        db.init_schema(conn)
        db.seed_if_empty(conn, normalize)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Identity + ingress helpers
# ---------------------------------------------------------------------------

def current_user() -> str:
    """Resolve the acting user for borrow attribution."""
    if DEV_MODE:
        return "Dev User"
    return (
        request.headers.get("X-Remote-User-Display-Name")
        or request.headers.get("X-Remote-User-Name")
        or "unknown"
    )


def ingress_base() -> str:
    """The <base href> value for the SPA."""
    if DEV_MODE:
        return "./"
    path = request.headers.get("X-Ingress-Path")
    if path:
        # Trailing slash required so relative URLs resolve under the prefix.
        return path.rstrip("/") + "/"
    return "./"


# ---------------------------------------------------------------------------
# Security: source-IP allowlist (PROD only)
# ---------------------------------------------------------------------------

@app.before_request
def enforce_ingress_allowlist():
    """In PROD, only the Supervisor proxy (172.30.32.2) may reach us."""
    if DEV_MODE:
        return None
    if request.remote_addr != INGRESS_ALLOWED_IP:
        return jsonify({"error": "forbidden"}), 403
    return None


# ---------------------------------------------------------------------------
# Serialization helpers — canonical JSON shapes (ADDENDA §5)
# ---------------------------------------------------------------------------

def _tags_list(raw) -> list:
    """Parse the items.tags JSON-array-text column into a Python list."""
    if not raw:
        return []
    try:
        val = json.loads(raw)
        return val if isinstance(val, list) else []
    except (ValueError, TypeError):
        return []


def _image_url(item_id: int, rel_path) -> str | None:
    """Build a relative 'api/images/<id>/<file>' url from a stored relative path."""
    if not rel_path:
        return None
    # Stored as 'images/<item_id>/<file>'; expose only the filename via the route.
    filename = os.path.basename(rel_path)
    return f"api/images/{item_id}/{filename}"


def serialize_locations(conn: sqlite3.Connection, item_id: int) -> list:
    """Minimal location refs for an item (ADDENDA §5: lean payloads)."""
    rows = conn.execute(
        "SELECT id, unit_id, cell_id, qty_here, is_primary "
        "FROM item_locations WHERE item_id=? ORDER BY is_primary DESC, id ASC",
        (item_id,),
    ).fetchall()
    return [
        {
            "id": r["id"],
            "unit_id": r["unit_id"],
            "cell_id": r["cell_id"],
            "qty_here": r["qty_here"],
            "is_primary": bool(r["is_primary"]),
        }
        for r in rows
    ]


def serialize_item(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    """Canonical <item> shape (ADDENDA §5), including minimal locations."""
    item_id = row["id"]
    return {
        "id": item_id,
        "name_en": row["name_en"],
        "name_fa": row["name_fa"],
        "name_da": row["name_da"],
        "brand": row["brand"],
        "category": row["category"],
        "qty": row["qty"],
        "tags": _tags_list(row["tags"]),
        "barcode": row["barcode"],
        "barcode_format": row["barcode_format"],
        "photo_url": _image_url(item_id, row["photo_path"]),
        "thumb_url": _image_url(item_id, row["thumb_path"]),
        "status": row["status"],
        "search": row["search"],
        "notes": row["notes"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "locations": serialize_locations(conn, item_id),
    }


def serialize_open_borrow(conn: sqlite3.Connection, item_id: int) -> dict | None:
    """The open borrow for an item (returned_at IS NULL), if any."""
    r = conn.execute(
        "SELECT id, borrowed_by, qty, borrowed_at, due_at, note "
        "FROM borrows WHERE item_id=? AND returned_at IS NULL "
        "ORDER BY borrowed_at DESC, id DESC LIMIT 1",
        (item_id,),
    ).fetchone()
    if r is None:
        return None
    return {
        "id": r["id"],
        "borrowed_by": r["borrowed_by"],
        "qty": r["qty"],
        "borrowed_at": r["borrowed_at"],
        "due_at": r["due_at"],
        "note": r["note"],
    }


def fetch_item_row(conn: sqlite3.Connection, item_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()


def compute_search(name_en, name_fa, name_da, brand, tags, barcode=None) -> str:
    """items.search = normalize(names + brand + tags joined + barcode)."""
    parts = [
        name_en or "",
        name_fa or "",
        name_da or "",
        brand or "",
        " ".join(tags or []),
        barcode or "",
    ]
    return normalize(" ".join(p for p in parts if p))


# ---------------------------------------------------------------------------
# Barcode normalization (UPC-A -> EAN-13 leading zero)
# ---------------------------------------------------------------------------

def normalize_barcode(code) -> str | None:
    """Strip non-digits; left-pad a 12-digit UPC-A to 13-digit EAN-13."""
    if code is None:
        return None
    digits = re.sub(r"\D", "", str(code))
    if not digits:
        return str(code).strip() or None  # keep non-numeric codes (e.g. QR text) as-is
    if len(digits) == 12:  # UPC-A -> EAN-13
        digits = "0" + digits
    return digits


# ---------------------------------------------------------------------------
# Static SPA serving (with <base href> injection)
# ---------------------------------------------------------------------------

def _inject_base(html, base_href):
    """
    Replace the LIVE <base> tag with one pointing at base_href, ignoring any
    example <base> that lives inside an HTML comment.

    Comments are masked (replaced by same-length spaces, preserving every
    index) before locating the tag, so a `<base href="{X-Ingress-Path}/">`
    example sitting in a comment can never be matched. The actual replacement
    is then spliced into the ORIGINAL html using the matched offsets.
    """
    # Mask HTML comments without changing length/indices.
    masked = re.sub(r"<!--.*?-->", lambda m: " " * len(m.group(0)), html, flags=re.S)
    m = re.search(r"<base\b[^>]*>", masked, flags=re.IGNORECASE)
    if m:
        return html[:m.start()] + f'<base href="{base_href}">' + html[m.end():]
    # Fallback: inject after <head ...> if present, else prepend.
    hm = re.search(r"<head\b[^>]*>", masked, flags=re.IGNORECASE)
    if hm:
        return html[:hm.end()] + f'<base href="{base_href}">' + html[hm.end():]
    return f'<base href="{base_href}">' + html


@app.route("/")
def index():
    """Serve index.html with the correct <base href> for the current request."""
    index_path = os.path.join(WWW_DIR, "index.html")
    if not os.path.exists(index_path):
        # Frontend not built yet (backend-only deploy); keep the app importable.
        return Response(
            "<!doctype html><meta charset=utf-8><base href=\"" + ingress_base()
            + "\"><title>Home Inventory</title><p>Frontend not present.</p>",
            mimetype="text/html",
        )
    with open(index_path, "r", encoding="utf-8") as fh:
        html = fh.read()
    return Response(_inject_base(html, ingress_base()), mimetype="text/html")


# Static assets (app.css, app.js, vendor/**, fonts, wasm, ...). Kept off the
# /api/ namespace so it never shadows the API. Path traversal is blocked by
# Flask's safe_join inside send_file via the normalized join below.
@app.route("/<path:filename>")
def static_files(filename):
    if filename.startswith("api/"):
        abort(404)
    safe = os.path.normpath(os.path.join(WWW_DIR, filename))
    if not safe.startswith(os.path.abspath(WWW_DIR) + os.sep):
        abort(404)
    if not os.path.isfile(safe):
        abort(404)
    return send_file(safe)


# ---------------------------------------------------------------------------
# API: identity + bootstrap
# ---------------------------------------------------------------------------

@app.route("/api/whoami")
def api_whoami():
    return jsonify({"user": current_user()})


@app.route("/api/bootstrap")
def api_bootstrap():
    """One-shot init payload for the SPA + Fuse index (ADDENDA §5 shape)."""
    conn = get_db()
    try:
        rooms = [
            {
                "id": r["id"], "name_en": r["name_en"], "name_fa": r["name_fa"],
                "name_da": r["name_da"], "icon": r["icon"], "sort_order": r["sort_order"],
            }
            for r in conn.execute(
                "SELECT * FROM rooms ORDER BY sort_order, id"
            ).fetchall()
        ]
        units = [
            _serialize_unit(conn, u)
            for u in conn.execute(
                "SELECT * FROM storage_units ORDER BY room_id, sort_order, id"
            ).fetchall()
        ]
        cells = [
            _serialize_cell(c)
            for c in conn.execute(
                "SELECT * FROM cells ORDER BY unit_id, row, col"
            ).fetchall()
        ]
        items = [
            serialize_item(conn, row)
            for row in conn.execute(
                "SELECT * FROM items ORDER BY id"
            ).fetchall()
        ]
        borrows_open = [
            {
                "id": b["id"], "item_id": b["item_id"], "borrowed_by": b["borrowed_by"],
                "qty": b["qty"], "borrowed_at": b["borrowed_at"], "due_at": b["due_at"],
                "note": b["note"],
            }
            for b in conn.execute(
                "SELECT * FROM borrows WHERE returned_at IS NULL "
                "ORDER BY borrowed_at DESC, id DESC"
            ).fetchall()
        ]
        nfc_tags = [
            serialize_nfc_tag(conn, t)
            for t in conn.execute(
                "SELECT * FROM nfc_tags ORDER BY created_at DESC, id DESC"
            ).fetchall()
        ]
        return jsonify({
            "user": current_user(),
            "ingress_base": ingress_base(),
            "rooms": rooms,
            "units": units,
            "cells": cells,
            "items": items,
            "borrows_open": borrows_open,
            "nfc_tags": nfc_tags,
            "ha_available": ha_client.ha_available(),
        })
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# API: items
# ---------------------------------------------------------------------------

def _location_exists_null_cell(conn, item_id, unit_id):
    """True if a unit-only (cell_id IS NULL) location already exists for this item.

    SQLite's UNIQUE(item_id,unit_id,cell_id) does NOT dedupe NULL cell_id rows
    (NULLs are distinct), so we check explicitly before inserting one.
    """
    return conn.execute(
        "SELECT 1 FROM item_locations "
        "WHERE item_id=? AND unit_id=? AND cell_id IS NULL LIMIT 1",
        (item_id, unit_id),
    ).fetchone() is not None


def _ensure_one_primary(conn, item_id):
    """If the item has locations but none is primary, mark the lowest-id one."""
    has_primary = conn.execute(
        "SELECT COUNT(*) AS n FROM item_locations WHERE item_id=? AND is_primary=1",
        (item_id,),
    ).fetchone()["n"]
    if has_primary:
        return
    lowest = conn.execute(
        "SELECT id FROM item_locations WHERE item_id=? ORDER BY id ASC LIMIT 1",
        (item_id,),
    ).fetchone()
    if lowest is not None:
        conn.execute(
            "UPDATE item_locations SET is_primary=1 WHERE id=?", (lowest["id"],)
        )


def _degrade_cell_locations(conn, unit_id, cell_id, affected_items: set) -> int:
    """
    Move item_locations off a cell that stops being trackable storage (zone
    dropped or turned 'open'): degrade them to unit-level (cell_id NULL),
    deduping against an existing unit-level row for the same item (SQLite's
    UNIQUE treats NULLs as distinct, so the dupe must be removed by hand).
    Returns the number of distinct items affected; adds their ids to
    `affected_items` so the caller can re-run _ensure_one_primary. No commit.
    """
    rows = conn.execute(
        "SELECT id, item_id FROM item_locations WHERE cell_id=?", (cell_id,)
    ).fetchall()
    if not rows:
        return 0
    item_ids = {r["item_id"] for r in rows}
    affected_items |= item_ids
    conn.execute(
        "DELETE FROM item_locations WHERE cell_id=? AND item_id IN ("
        "  SELECT item_id FROM item_locations "
        "  WHERE unit_id=? AND cell_id IS NULL)",
        (cell_id, unit_id),
    )
    conn.execute(
        "UPDATE item_locations SET cell_id=NULL WHERE cell_id=?", (cell_id,)
    )
    return len(item_ids)


def _insert_locations(conn, item_id, locations):
    """Insert item_locations rows from a list of {unit_id, cell_id, qty_here, is_primary}."""
    if not locations:
        return
    for i, loc in enumerate(locations):
        if not isinstance(loc, dict):
            continue
        unit_id = loc.get("unit_id")
        if unit_id is None:
            continue
        cell_id = loc.get("cell_id")
        # Dedupe unit-only locations (NULL cell_id is not covered by the UNIQUE).
        if cell_id is None and _location_exists_null_cell(conn, item_id, unit_id):
            continue
        qty_here = max(0, as_int(loc.get("qty_here", 1), 1))
        # First location defaults to primary unless explicitly stated.
        is_primary = int(bool(loc.get("is_primary", i == 0)))
        conn.execute(
            "INSERT OR IGNORE INTO item_locations "
            "(item_id, unit_id, cell_id, qty_here, is_primary) VALUES (?,?,?,?,?)",
            (item_id, unit_id, cell_id, qty_here, is_primary),
        )


@app.route("/api/items", methods=["GET"])
def api_items_list():
    """List items, optionally filtered. Each item carries locations/thumb/search."""
    status = request.args.get("status")
    barcode = request.args.get("barcode")
    room_id = request.args.get("room_id", type=int)
    unit_id = request.args.get("unit_id", type=int)
    limit = request.args.get("limit", type=int)
    offset = request.args.get("offset", type=int)

    where = []
    params = []
    join = ""
    if status:
        where.append("i.status = ?")
        params.append(status)
    if barcode:
        # Exact match on the normalized barcode (uses idx_items_barcode).
        where.append("i.barcode = ?")
        params.append(normalize_barcode(barcode))
    if unit_id is not None:
        join = "JOIN item_locations il ON il.item_id = i.id"
        where.append("il.unit_id = ?")
        params.append(unit_id)
    elif room_id is not None:
        join = ("JOIN item_locations il ON il.item_id = i.id "
                "JOIN storage_units su ON su.id = il.unit_id")
        where.append("su.room_id = ?")
        params.append(room_id)

    sql = f"SELECT DISTINCT i.* FROM items i {join}"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY i.id"
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
        if offset is not None:
            sql += " OFFSET ?"
            params.append(offset)

    conn = get_db()
    try:
        rows = conn.execute(sql, params).fetchall()
        return jsonify({"items": [serialize_item(conn, r) for r in rows]})
    finally:
        conn.close()


@app.route("/api/items/recent", methods=["GET"])
def api_items_recent():
    """Newest items first (home screen). Default limit 20."""
    limit = request.args.get("limit", default=20, type=int)
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM items ORDER BY created_at DESC, id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return jsonify({"items": [serialize_item(conn, r) for r in rows]})
    finally:
        conn.close()


@app.route("/api/items/<int:item_id>", methods=["GET"])
def api_item_get(item_id):
    """Full item + open borrow (ADDENDA §5 adds `borrow`)."""
    conn = get_db()
    try:
        row = fetch_item_row(conn, item_id)
        if row is None:
            return jsonify({"error": "not found"}), 404
        out = serialize_item(conn, row)
        out["borrow"] = serialize_open_borrow(conn, item_id)
        return jsonify(out)
    finally:
        conn.close()


@app.route("/api/items", methods=["POST"])
def api_item_create():
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    name_en = body.get("name_en", "") or ""
    name_fa = body.get("name_fa", "") or ""
    name_da = body.get("name_da", "") or ""
    brand = body.get("brand", "") or ""
    category = body.get("category", "") or ""
    qty = max(0, as_int(body.get("qty", 1), 1))
    tags = body.get("tags") or []
    if not isinstance(tags, list):
        tags = []
    barcode = normalize_barcode(body.get("barcode"))
    barcode_format = body.get("barcode_format")
    notes = body.get("notes", "") or ""
    locations = body.get("locations") or []
    search = compute_search(name_en, name_fa, name_da, brand, tags, barcode)

    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO items "
            "(name_en, name_fa, name_da, brand, category, qty, tags, "
            " barcode, barcode_format, notes, search) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (name_en, name_fa, name_da, brand, category, qty,
             json.dumps(tags, ensure_ascii=False), barcode, barcode_format,
             notes, search),
        )
        item_id = cur.lastrowid
        _insert_locations(conn, item_id, locations)
        _ensure_one_primary(conn, item_id)
        conn.commit()
        row = fetch_item_row(conn, item_id)
        return jsonify(serialize_item(conn, row)), 201
    finally:
        conn.close()


@app.route("/api/items/<int:item_id>", methods=["PATCH"])
def api_item_update(item_id):
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    # Reject an out-of-domain status before touching the DB (CHECK would 500).
    if "status" in body and body["status"] not in (
        "in_stock", "borrowed", "lost", "archived"
    ):
        return jsonify({"error": "invalid status"}), 400
    conn = get_db()
    try:
        row = fetch_item_row(conn, item_id)
        if row is None:
            return jsonify({"error": "not found"}), 404

        # Build the merged values; only update provided keys.
        fields = {}
        for key in ("name_en", "name_fa", "name_da", "brand", "category",
                    "notes", "status", "barcode_format"):
            if key in body:
                fields[key] = body[key] if body[key] is not None else ""
        if "qty" in body:
            fields["qty"] = max(0, as_int(body["qty"], row["qty"]))
        if "tags" in body:
            tags = body["tags"] if isinstance(body["tags"], list) else []
            fields["tags"] = json.dumps(tags, ensure_ascii=False)
        if "barcode" in body:
            fields["barcode"] = normalize_barcode(body["barcode"])

        # Recompute search from the merged (new-or-existing) values.
        merged_tags = _tags_list(fields["tags"]) if "tags" in fields else _tags_list(row["tags"])
        fields["search"] = compute_search(
            fields.get("name_en", row["name_en"]),
            fields.get("name_fa", row["name_fa"]),
            fields.get("name_da", row["name_da"]),
            fields.get("brand", row["brand"]),
            merged_tags,
            fields["barcode"] if "barcode" in fields else row["barcode"],
        )
        fields["updated_at"] = "__now__"  # sentinel, handled below

        sets = []
        params = []
        for key, val in fields.items():
            if key == "updated_at":
                sets.append("updated_at = datetime('now')")
                continue
            sets.append(f"{key} = ?")
            params.append(val)
        params.append(item_id)
        conn.execute(f"UPDATE items SET {', '.join(sets)} WHERE id=?", params)

        # Optional full-replace of locations when provided.
        if "locations" in body and isinstance(body["locations"], list):
            conn.execute("DELETE FROM item_locations WHERE item_id=?", (item_id,))
            _insert_locations(conn, item_id, body["locations"])
            _ensure_one_primary(conn, item_id)

        conn.commit()
        return jsonify(serialize_item(conn, fetch_item_row(conn, item_id)))
    finally:
        conn.close()


@app.route("/api/items/<int:item_id>", methods=["DELETE"])
def api_item_delete(item_id):
    conn = get_db()
    try:
        row = fetch_item_row(conn, item_id)
        if row is None:
            return jsonify({"error": "not found"}), 404
        conn.execute("DELETE FROM items WHERE id=?", (item_id,))
        db.nfc_delete_for_targets(conn, "item", [item_id])
        conn.commit()
        # Also remove the item's image directory if present.
        _delete_image_dir(item_id)
        return jsonify({"ok": True})
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# API: item photo (upload + 256px Pillow thumbnail) + serving
# ---------------------------------------------------------------------------

def _item_image_dir(item_id: int) -> str:
    return os.path.join(IMAGES_DIR, str(item_id))


def _delete_image_dir(item_id: int) -> None:
    d = _item_image_dir(item_id)
    if os.path.isdir(d):
        for name in os.listdir(d):
            try:
                os.remove(os.path.join(d, name))
            except OSError:
                pass
        try:
            os.rmdir(d)
        except OSError:
            pass


@app.route("/api/items/<int:item_id>/photo", methods=["POST"])
def api_item_photo_upload(item_id):
    conn = get_db()
    try:
        if fetch_item_row(conn, item_id) is None:
            return jsonify({"error": "not found"}), 404

        file = request.files.get("file")
        if file is None or not file.filename:
            return jsonify({"error": "no file"}), 400

        try:
            img = Image.open(file.stream)
            img.load()
        except Exception:
            return jsonify({"error": "invalid image"}), 400

        # Normalize to RGB (handles PNG alpha, CMYK, etc.) for JPEG output.
        if img.mode not in ("RGB",):
            img = img.convert("RGB")

        item_dir = _item_image_dir(item_id)
        os.makedirs(item_dir, exist_ok=True)
        # Remove any prior images (one photo per item in v1).
        for name in os.listdir(item_dir):
            try:
                os.remove(os.path.join(item_dir, name))
            except OSError:
                pass

        stem = uuid.uuid4().hex
        full_name = f"{stem}.jpg"
        thumb_name = f"{stem}.thumb.jpg"
        full_fs = os.path.join(item_dir, full_name)
        thumb_fs = os.path.join(item_dir, thumb_name)

        img.save(full_fs, "JPEG", quality=88, optimize=True)

        thumb = img.copy()
        thumb.thumbnail((THUMB_MAX_EDGE, THUMB_MAX_EDGE), Image.LANCZOS)
        thumb.save(thumb_fs, "JPEG", quality=82, optimize=True)

        # Store paths relative to DATA_DIR.
        photo_path = f"images/{item_id}/{full_name}"
        thumb_path = f"images/{item_id}/{thumb_name}"
        conn.execute(
            "UPDATE items SET photo_path=?, thumb_path=?, updated_at=datetime('now') "
            "WHERE id=?",
            (photo_path, thumb_path, item_id),
        )
        conn.commit()
        return jsonify({
            "photo_url": _image_url(item_id, photo_path),
            "thumb_url": _image_url(item_id, thumb_path),
        })
    finally:
        conn.close()


@app.route("/api/items/<int:item_id>/photo", methods=["DELETE"])
def api_item_photo_delete(item_id):
    conn = get_db()
    try:
        if fetch_item_row(conn, item_id) is None:
            return jsonify({"error": "not found"}), 404
        conn.execute(
            "UPDATE items SET photo_path=NULL, thumb_path=NULL, "
            "updated_at=datetime('now') WHERE id=?",
            (item_id,),
        )
        conn.commit()
        _delete_image_dir(item_id)
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.route("/api/images/<int:item_id>/<path:filename>")
def api_image_serve(item_id, filename):
    """Serve a stored image from {DATA_DIR}/images/<item_id>/."""
    item_dir = _item_image_dir(item_id)
    safe = os.path.normpath(os.path.join(item_dir, filename))
    if not safe.startswith(os.path.abspath(item_dir) + os.sep):
        abort(404)
    if not os.path.isfile(safe):
        abort(404)
    return send_file(safe, mimetype="image/jpeg")


# ---------------------------------------------------------------------------
# API: item locations (add / remove)
# ---------------------------------------------------------------------------

@app.route("/api/items/<int:item_id>/locations", methods=["POST"])
def api_item_location_add(item_id):
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    unit_id = body.get("unit_id")
    if unit_id is None:
        return jsonify({"error": "unit_id required"}), 400
    cell_id = body.get("cell_id")
    qty_here = max(0, as_int(body.get("qty_here", 1), 1))
    is_primary = int(bool(body.get("is_primary", False)))

    conn = get_db()
    try:
        if fetch_item_row(conn, item_id) is None:
            return jsonify({"error": "not found"}), 404
        # Dedupe unit-only locations (NULL cell_id is not covered by the UNIQUE).
        if cell_id is None and _location_exists_null_cell(conn, item_id, unit_id):
            return jsonify({"locations": serialize_locations(conn, item_id)})
        if is_primary:
            conn.execute(
                "UPDATE item_locations SET is_primary=0 WHERE item_id=?", (item_id,)
            )
        conn.execute(
            "INSERT OR IGNORE INTO item_locations "
            "(item_id, unit_id, cell_id, qty_here, is_primary) VALUES (?,?,?,?,?)",
            (item_id, unit_id, cell_id, qty_here, is_primary),
        )
        _ensure_one_primary(conn, item_id)
        conn.commit()
        return jsonify({"locations": serialize_locations(conn, item_id)})
    finally:
        conn.close()


@app.route("/api/items/<int:item_id>/locations/<int:loc_id>", methods=["DELETE"])
def api_item_location_delete(item_id, loc_id):
    conn = get_db()
    try:
        cur = conn.execute(
            "DELETE FROM item_locations WHERE id=? AND item_id=?", (loc_id, item_id)
        )
        conn.commit()
        if cur.rowcount == 0:
            return jsonify({"error": "not found"}), 404
        return jsonify({"ok": True})
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# API: borrow checkout / return + borrows list
# ---------------------------------------------------------------------------

@app.route("/api/borrows", methods=["GET"])
def api_borrows_list():
    """Borrows joined with item names (Borrowed view). ?open=1 -> only open."""
    only_open = request.args.get("open") in ("1", "true", "yes")
    conn = get_db()
    try:
        sql = (
            "SELECT b.*, i.name_en, i.name_fa, i.name_da, i.brand "
            "FROM borrows b JOIN items i ON i.id = b.item_id"
        )
        if only_open:
            sql += " WHERE b.returned_at IS NULL"
        sql += " ORDER BY b.borrowed_at DESC, b.id DESC"
        rows = conn.execute(sql).fetchall()
        borrows = [
            {
                "id": r["id"], "item_id": r["item_id"], "borrowed_by": r["borrowed_by"],
                "borrowed_by_ha": r["borrowed_by_ha"], "qty": r["qty"],
                "borrowed_at": r["borrowed_at"], "due_at": r["due_at"],
                "returned_at": r["returned_at"], "note": r["note"],
                "item": {
                    "id": r["item_id"], "name_en": r["name_en"],
                    "name_fa": r["name_fa"], "name_da": r["name_da"],
                    "brand": r["brand"],
                },
            }
            for r in rows
        ]
        return jsonify({"borrows": borrows})
    finally:
        conn.close()


@app.route("/api/items/<int:item_id>/checkout", methods=["POST"])
def api_item_checkout(item_id):
    """Open a borrow row and set status='borrowed'."""
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    borrowed_by = body.get("borrowed_by", "") or ""
    qty = max(0, as_int(body.get("qty", 1), 1))
    due_at = body.get("due_at")
    note = body.get("note", "") or ""

    conn = get_db()
    try:
        if fetch_item_row(conn, item_id) is None:
            return jsonify({"error": "not found"}), 404
        cur = conn.execute(
            "INSERT INTO borrows "
            "(item_id, borrowed_by, borrowed_by_ha, qty, due_at, note) "
            "VALUES (?,?,?,?,?,?)",
            (item_id, borrowed_by, current_user(), qty, due_at, note),
        )
        borrow_id = cur.lastrowid
        conn.execute(
            "UPDATE items SET status='borrowed', updated_at=datetime('now') WHERE id=?",
            (item_id,),
        )
        conn.commit()
        item = serialize_item(conn, fetch_item_row(conn, item_id))
        borrow = serialize_open_borrow(conn, item_id)
        # serialize_open_borrow returns the most recent open one; ensure it's ours.
        if borrow is None or borrow["id"] != borrow_id:
            br = conn.execute(
                "SELECT id, borrowed_by, qty, borrowed_at, due_at, note "
                "FROM borrows WHERE id=?", (borrow_id,)
            ).fetchone()
            borrow = dict(br) if br else None
        return jsonify({"item": item, "borrow": borrow}), 201
    finally:
        conn.close()


@app.route("/api/items/<int:item_id>/return", methods=["POST"])
def api_item_return(item_id):
    """Close an open borrow; set status back to in_stock if none remain open."""
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    borrow_id = body.get("borrow_id")

    conn = get_db()
    try:
        if fetch_item_row(conn, item_id) is None:
            return jsonify({"error": "not found"}), 404

        if borrow_id is not None:
            target = conn.execute(
                "SELECT * FROM borrows WHERE id=? AND item_id=? AND returned_at IS NULL",
                (borrow_id, item_id),
            ).fetchone()
        else:
            target = conn.execute(
                "SELECT * FROM borrows WHERE item_id=? AND returned_at IS NULL "
                "ORDER BY borrowed_at DESC, id DESC LIMIT 1",
                (item_id,),
            ).fetchone()

        if target is None:
            return jsonify({"error": "no open borrow"}), 400

        conn.execute(
            "UPDATE borrows SET returned_at=datetime('now') WHERE id=?",
            (target["id"],),
        )
        # If no open borrows remain, flip status back to in_stock (only from borrowed).
        remaining = conn.execute(
            "SELECT COUNT(*) AS n FROM borrows WHERE item_id=? AND returned_at IS NULL",
            (item_id,),
        ).fetchone()["n"]
        if remaining == 0:
            conn.execute(
                "UPDATE items SET status='in_stock', updated_at=datetime('now') "
                "WHERE id=? AND status='borrowed'",
                (item_id,),
            )
        conn.commit()

        item = serialize_item(conn, fetch_item_row(conn, item_id))
        closed = conn.execute(
            "SELECT id, borrowed_by, qty, borrowed_at, due_at, returned_at, note "
            "FROM borrows WHERE id=?", (target["id"],)
        ).fetchone()
        return jsonify({"item": item, "borrow": dict(closed) if closed else None})
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# API: rooms
# ---------------------------------------------------------------------------

def _serialize_room(r):
    return {
        "id": r["id"], "name_en": r["name_en"], "name_fa": r["name_fa"],
        "name_da": r["name_da"], "icon": r["icon"], "sort_order": r["sort_order"],
    }


@app.route("/api/rooms", methods=["GET"])
def api_rooms_list():
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM rooms ORDER BY sort_order, id").fetchall()
        return jsonify({"rooms": [_serialize_room(r) for r in rows]})
    finally:
        conn.close()


@app.route("/api/rooms", methods=["POST"])
def api_room_create():
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO rooms (name_en, name_fa, name_da, icon, sort_order) "
            "VALUES (?,?,?,?,?)",
            (body.get("name_en", "") or "", body.get("name_fa", "") or "",
             body.get("name_da", "") or "", body.get("icon"),
             as_int(body.get("sort_order", 0), 0)),
        )
        conn.commit()
        r = conn.execute("SELECT * FROM rooms WHERE id=?", (cur.lastrowid,)).fetchone()
        return jsonify(_serialize_room(r)), 201
    finally:
        conn.close()


@app.route("/api/rooms/<int:room_id>", methods=["PATCH"])
def api_room_update(room_id):
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    conn = get_db()
    try:
        if conn.execute("SELECT 1 FROM rooms WHERE id=?", (room_id,)).fetchone() is None:
            return jsonify({"error": "not found"}), 404
        sets, params = [], []
        for key in ("name_en", "name_fa", "name_da", "icon"):
            if key in body:
                sets.append(f"{key} = ?")
                params.append(body[key])
        if "sort_order" in body:
            sets.append("sort_order = ?")
            params.append(as_int(body["sort_order"], 0))
        if sets:
            params.append(room_id)
            conn.execute(f"UPDATE rooms SET {', '.join(sets)} WHERE id=?", params)
            conn.commit()
        r = conn.execute("SELECT * FROM rooms WHERE id=?", (room_id,)).fetchone()
        return jsonify(_serialize_room(r))
    finally:
        conn.close()


@app.route("/api/rooms/<int:room_id>", methods=["DELETE"])
def api_room_delete(room_id):
    conn = get_db()
    try:
        # Units and cells cascade away with the room — collect their ids first
        # so the (FK-less) NFC tag assignments can be cleaned up too.
        unit_ids = [u["id"] for u in conn.execute(
            "SELECT id FROM storage_units WHERE room_id=?", (room_id,)
        ).fetchall()]
        cell_ids = []
        if unit_ids:
            qs = ",".join("?" * len(unit_ids))
            cell_ids = [c["id"] for c in conn.execute(
                f"SELECT id FROM cells WHERE unit_id IN ({qs})", unit_ids
            ).fetchall()]
        cur = conn.execute("DELETE FROM rooms WHERE id=?", (room_id,))
        if cur.rowcount == 0:
            conn.rollback()
            return jsonify({"error": "not found"}), 404
        db.nfc_delete_for_targets(conn, "unit", unit_ids)
        db.nfc_delete_for_targets(conn, "cell", cell_ids)
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# API: storage units + cells
# ---------------------------------------------------------------------------

# Layout modes: 'grid' (uniform rows x cols), 'closet' (sections + zones),
# 'none' (no internal layout).
UNIT_LAYOUTS = ("grid", "closet", "none")
# Valid zone kinds in closet mode. 'open' = open space, display-only.
CLOSET_ZONE_KINDS = ("drawer", "shelf", "hanging", "basket", "open")
# Trackable (assignable / storage) zone kinds in closet mode.
CLOSET_TRACKABLE_KINDS = ("drawer", "shelf", "hanging", "basket")


def _cell_trackable(kind, layout):
    """Business rule: which compartments are real (assignable) storage.

    grid (and legacy/none) : only 'door' cells;
    closet                 : drawer/shelf/hanging/basket ('open' is display-only).
    """
    if layout == "closet":
        return kind in CLOSET_TRACKABLE_KINDS
    return kind == "door"


def _unit_sections(conn, unit_id):
    """Closet section geometry rows for a unit (lean, bootstrap-friendly)."""
    return [
        {
            "col": s["col_index"],
            "width_cm": s["width_cm"],
            "corner": bool(s["corner"]),
        }
        for s in conn.execute(
            "SELECT * FROM unit_sections WHERE unit_id=? ORDER BY sort, col_index",
            (unit_id,),
        ).fetchall()
    ]


def _serialize_unit(conn, u):
    return {
        "id": u["id"], "room_id": u["room_id"], "name_en": u["name_en"],
        "name_fa": u["name_fa"], "name_da": u["name_da"],
        "grid_rows": u["grid_rows"], "grid_cols": u["grid_cols"],
        "layout": u["layout"], "height_cm": u["height_cm"],
        "sections": (_unit_sections(conn, u["id"])
                     if u["layout"] == "closet" else []),
        "sort_order": u["sort_order"],
    }


def _serialize_cell(c):
    return {
        "id": c["id"], "unit_id": c["unit_id"], "row": c["row"], "col": c["col"],
        "row_span": c["row_span"], "col_span": c["col_span"],
        "label_en": c["label_en"], "label_fa": c["label_fa"], "label_da": c["label_da"],
        "kind": c["kind"], "height_cm": c["height_cm"],
    }


def _coerce_kind(value):
    """Grid cell kind is 'door' or 'open'; coerce anything not 'open' to 'door'."""
    return "open" if value == "open" else "door"


def _is_num(v):
    """True for real JSON numbers (bool is an int subclass — exclude it)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _cell_label(row, col):
    """Coordinate label: col letter A.. by col, row number 1.. by row."""
    return f"{chr(ord('A') + col)}{row + 1}"


def _auto_create_cells(conn, unit_id, rows, cols):
    """Create a fresh rows x cols grid of cells with coordinate labels (kind='door')."""
    for row in range(rows):
        for col in range(cols):
            conn.execute(
                "INSERT OR IGNORE INTO cells "
                "(unit_id, row, col, row_span, col_span, label_en, label_fa, label_da, kind) "
                "VALUES (?,?,?,?,?,?,?,?,'door')",
                (unit_id, row, col, 1, 1, _cell_label(row, col), "", ""),
            )


@app.route("/api/units", methods=["GET"])
def api_units_list():
    room_id = request.args.get("room_id", type=int)
    conn = get_db()
    try:
        if room_id is not None:
            rows = conn.execute(
                "SELECT * FROM storage_units WHERE room_id=? ORDER BY sort_order, id",
                (room_id,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM storage_units ORDER BY room_id, sort_order, id"
            ).fetchall()
        return jsonify({"units": [_serialize_unit(conn, u) for u in rows]})
    finally:
        conn.close()


@app.route("/api/units", methods=["POST"])
def api_unit_create():
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    room_id = body.get("room_id")
    if room_id is None:
        return jsonify({"error": "room_id required"}), 400
    req_layout = body.get("layout")
    if req_layout is not None and req_layout not in UNIT_LAYOUTS:
        return jsonify({"error": "invalid layout"}), 400
    height_cm = body.get("height_cm")
    if height_cm is not None and (not _is_num(height_cm)
                                  or not 50 <= height_cm <= 400):
        return jsonify(
            {"error": "height_cm must be a number between 50 and 400, or null"}
        ), 400
    # Clamp grid dimensions to [0,20] (matches the frontend grid editor cap).
    grid_rows = max(0, min(20, as_int(body.get("grid_rows", 0), 0)))
    grid_cols = max(0, min(20, as_int(body.get("grid_cols", 0), 0)))
    # Invariant: layout=='grid' <=> rows>0 and cols>0; closet/none carry 0x0.
    # A closet is created empty here — sections/zones arrive via PUT /layout.
    if req_layout == "closet":
        layout, grid_rows, grid_cols = "closet", 0, 0
    elif req_layout == "none":
        layout, grid_rows, grid_cols = "none", 0, 0
    else:
        layout = "grid" if (grid_rows > 0 and grid_cols > 0) else "none"
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO storage_units "
            "(room_id, name_en, name_fa, name_da, grid_rows, grid_cols, "
            " layout, height_cm, sort_order) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (room_id, body.get("name_en", "") or "", body.get("name_fa", "") or "",
             body.get("name_da", "") or "", grid_rows, grid_cols,
             layout, height_cm, as_int(body.get("sort_order", 0), 0)),
        )
        unit_id = cur.lastrowid
        if layout == "grid":
            _auto_create_cells(conn, unit_id, grid_rows, grid_cols)
        conn.commit()
        u = conn.execute(
            "SELECT * FROM storage_units WHERE id=?", (unit_id,)
        ).fetchone()
        return jsonify(_serialize_unit(conn, u)), 201
    finally:
        conn.close()


@app.route("/api/units/<int:unit_id>", methods=["PATCH"])
def api_unit_update(unit_id):
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    conn = get_db()
    try:
        u = conn.execute(
            "SELECT * FROM storage_units WHERE id=?", (unit_id,)
        ).fetchone()
        if u is None:
            return jsonify({"error": "not found"}), 404

        # ----- layout-mode validation ---------------------------------------
        # PATCH may switch to 'grid'/'none' only; 'closet' is entered solely
        # via PUT /api/units/<id>/layout (which needs the sections payload).
        req_layout = None
        if "layout" in body:
            req_layout = body["layout"]
            if req_layout == "closet":
                return jsonify({
                    "error": "closet layout is set via PUT /api/units/<id>/layout"
                }), 400
            if req_layout not in ("grid", "none"):
                return jsonify({"error": "invalid layout"}), 400
        if (u["layout"] == "closet" and req_layout is None
                and ("grid_rows" in body or "grid_cols" in body)):
            return jsonify({
                "error": "unit uses closet layout; "
                         "use /api/units/<id>/layout (or switch layout first)"
            }), 400
        if "height_cm" in body:
            h = body["height_cm"]
            if h is not None and (not _is_num(h) or not 50 <= h <= 400):
                return jsonify({
                    "error": "height_cm must be a number between 50 and 400, or null"
                }), 400

        sets, params = [], []
        for key in ("name_en", "name_fa", "name_da", "room_id"):
            if key in body:
                sets.append(f"{key} = ?")
                params.append(body[key])
        if "sort_order" in body:
            sets.append("sort_order = ?")
            params.append(as_int(body["sort_order"], 0))
        if "height_cm" in body:
            sets.append("height_cm = ?")
            params.append(body["height_cm"])

        # ----- leaving closet mode: tear the sections/zones down -------------
        # Zones are deleted (item locations degrade to unit-level, NFC cell
        # tags removed) and the section geometry dropped; then the normal grid
        # logic below may build a fresh grid from the requested dims.
        leaving_closet = (u["layout"] == "closet" and req_layout is not None)
        if leaving_closet:
            affected = set()
            old_cells = conn.execute(
                "SELECT id FROM cells WHERE unit_id=?", (unit_id,)
            ).fetchall()
            for c in old_cells:
                _degrade_cell_locations(conn, unit_id, c["id"], affected)
            db.nfc_delete_for_targets(conn, "cell", [c["id"] for c in old_cells])
            conn.execute("DELETE FROM cells WHERE unit_id=?", (unit_id,))
            conn.execute("DELETE FROM unit_sections WHERE unit_id=?", (unit_id,))
            for iid in affected:
                _ensure_one_primary(conn, iid)

        # ----- grid dims + derived layout ------------------------------------
        if u["layout"] == "closet" and not leaving_closet:
            # Names/sort/height-only PATCH on a closet: leave layout untouched.
            final_rows, final_cols, final_layout = 0, 0, "closet"
            grid_changed = False
        else:
            base_rows = 0 if leaving_closet else u["grid_rows"]
            base_cols = 0 if leaving_closet else u["grid_cols"]
            # Grid resize: re-sync cells. New cells added; cells outside the
            # new bounds removed; existing in-bounds cells (labels too) kept.
            # Clamp to [0,20] (matches the frontend grid editor cap).
            final_rows = (max(0, min(20, as_int(body["grid_rows"], base_rows)))
                          if "grid_rows" in body else base_rows)
            final_cols = (max(0, min(20, as_int(body["grid_cols"], base_cols)))
                          if "grid_cols" in body else base_cols)
            if req_layout == "none":
                # Explicit 'none' = clear any grid.
                final_rows = final_cols = 0
            # Invariant: layout=='grid' <=> rows>0 and cols>0.
            final_layout = ("grid" if (final_rows > 0 and final_cols > 0)
                            else "none")
            grid_changed = (final_rows != u["grid_rows"]
                            or final_cols != u["grid_cols"])

        if final_rows != u["grid_rows"]:
            sets.append("grid_rows = ?")
            params.append(final_rows)
        if final_cols != u["grid_cols"]:
            sets.append("grid_cols = ?")
            params.append(final_cols)
        if final_layout != u["layout"]:
            sets.append("layout = ?")
            params.append(final_layout)

        if sets:
            params.append(unit_id)
            conn.execute(
                f"UPDATE storage_units SET {', '.join(sets)} WHERE id=?", params
            )

        if grid_changed:
            # Remove out-of-bounds cells (collect ids first: their NFC tag
            # assignments must be cleaned up — nfc_tags has no FK).
            dropped = [c["id"] for c in conn.execute(
                "SELECT id FROM cells WHERE unit_id=? AND (row >= ? OR col >= ?)",
                (unit_id, final_rows, final_cols),
            ).fetchall()]
            conn.execute(
                "DELETE FROM cells WHERE unit_id=? AND (row >= ? OR col >= ?)",
                (unit_id, final_rows, final_cols),
            )
            db.nfc_delete_for_targets(conn, "cell", dropped)
            # Add any missing in-bounds cells.
            if final_rows > 0 and final_cols > 0:
                _auto_create_cells(conn, unit_id, final_rows, final_cols)

        conn.commit()
        u2 = conn.execute(
            "SELECT * FROM storage_units WHERE id=?", (unit_id,)
        ).fetchone()
        return jsonify(_serialize_unit(conn, u2))
    finally:
        conn.close()


@app.route("/api/units/<int:unit_id>", methods=["DELETE"])
def api_unit_delete(unit_id):
    conn = get_db()
    try:
        # Cells cascade away with the unit — collect ids first for NFC cleanup.
        cell_ids = [c["id"] for c in conn.execute(
            "SELECT id FROM cells WHERE unit_id=?", (unit_id,)
        ).fetchall()]
        cur = conn.execute("DELETE FROM storage_units WHERE id=?", (unit_id,))
        if cur.rowcount == 0:
            conn.rollback()
            return jsonify({"error": "not found"}), 404
        db.nfc_delete_for_targets(conn, "unit", [unit_id])
        db.nfc_delete_for_targets(conn, "cell", cell_ids)
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.route("/api/units/<int:unit_id>/cells", methods=["GET"])
def api_unit_cells_get(unit_id):
    conn = get_db()
    try:
        u = conn.execute(
            "SELECT layout FROM storage_units WHERE id=?", (unit_id,)
        ).fetchone()
        if u is None:
            return jsonify({"error": "not found"}), 404
        if u["layout"] == "closet":
            return jsonify({
                "error": "unit uses closet layout; use /api/units/<id>/layout"
            }), 400
        rows = conn.execute(
            "SELECT * FROM cells WHERE unit_id=? ORDER BY row, col", (unit_id,)
        ).fetchall()
        return jsonify({"cells": [_serialize_cell(c) for c in rows]})
    finally:
        conn.close()


@app.route("/api/units/<int:unit_id>/cells", methods=["PUT"])
def api_unit_cells_put(unit_id):
    """Bulk replace a unit's cells (grid editor save)."""
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    cells = body.get("cells")
    if not isinstance(cells, list):
        return jsonify({"error": "cells array required"}), 400
    conn = get_db()
    try:
        u = conn.execute(
            "SELECT layout FROM storage_units WHERE id=?", (unit_id,)
        ).fetchone()
        if u is None:
            return jsonify({"error": "not found"}), 404
        if u["layout"] == "closet":
            return jsonify({
                "error": "unit uses closet layout; use /api/units/<id>/layout"
            }), 400
        # The replace assigns fresh cell ids, so remember which (row,col)
        # positions carry an NFC tag; the tags get retargeted (or dropped)
        # after the re-insert below.
        tagged_positions = conn.execute(
            "SELECT t.id AS nfc_id, c.row, c.col FROM nfc_tags t "
            "JOIN cells c ON c.id = t.target_id "
            "WHERE t.target_kind='cell' AND c.unit_id=?",
            (unit_id,),
        ).fetchall()
        conn.execute("DELETE FROM cells WHERE unit_id=?", (unit_id,))
        for c in cells:
            if not isinstance(c, dict):
                continue
            conn.execute(
                "INSERT OR IGNORE INTO cells "
                "(unit_id, row, col, row_span, col_span, label_en, label_fa, label_da, kind) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (unit_id, max(0, as_int(c.get("row", 0), 0)),
                 max(0, as_int(c.get("col", 0), 0)),
                 max(1, as_int(c.get("row_span", 1), 1)),
                 max(1, as_int(c.get("col_span", 1), 1)),
                 c.get("label_en", "") or "", c.get("label_fa", "") or "",
                 c.get("label_da", "") or "", _coerce_kind(c.get("kind"))),
            )
        # Re-point NFC tags at the new cell occupying the same position; drop
        # the tag when the position vanished or is no longer a 'door'
        # (only door compartments are NFC-assignable).
        for t in tagged_positions:
            nc = conn.execute(
                "SELECT id, kind FROM cells WHERE unit_id=? AND row=? AND col=?",
                (unit_id, t["row"], t["col"]),
            ).fetchone()
            if nc is not None and nc["kind"] == "door":
                conn.execute(
                    "UPDATE nfc_tags SET target_id=? WHERE id=?",
                    (nc["id"], t["nfc_id"]),
                )
            else:
                conn.execute(
                    "DELETE FROM nfc_tags WHERE id=?", (t["nfc_id"],)
                )
        conn.commit()
        rows = conn.execute(
            "SELECT * FROM cells WHERE unit_id=? ORDER BY row, col", (unit_id,)
        ).fetchall()
        return jsonify({"cells": [_serialize_cell(c) for c in rows]})
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# API: closet layouts (sections + zones) — layout='closet' units
# ---------------------------------------------------------------------------
#
# Model recap: a closet is vertical SECTIONS (left->right, unit_sections rows,
# col_index 0-based) each stacked with ZONES top->bottom. Zones live in the
# ordinary `cells` table (col = section index, row = zone index) so that
# item_locations.cell_id, NFC cell targets, contents sheets and count badges
# keep working unchanged.

def _layout_err(message, section=None, zone=None):
    """400 payload for layout validation; carries indices when relevant."""
    out = {"error": message}
    if section is not None:
        out["section"] = section
    if zone is not None:
        out["zone"] = zone
    return jsonify(out), 400


def _validate_layout_body(body):
    """
    Validate + parse a PUT /layout body. Returns (error_response, parsed):
    exactly one is None. Parsed shape:
      {"height_cm": float, "sections": [
          {"width_cm": float, "corner": bool, "zones": [
              {"kind": str, "height_cm": float|None,
               "label_en": str, "label_fa": str, "label_da": str}]}]}
    """
    h = body.get("height_cm")
    if not _is_num(h) or not 50 <= h <= 400:
        return _layout_err("height_cm must be a number between 50 and 400"), None
    sections = body.get("sections")
    if not isinstance(sections, list) or len(sections) < 1:
        return _layout_err("at least one section is required"), None
    if len(sections) > 8:
        return _layout_err("at most 8 sections are allowed"), None
    parsed_sections = []
    for i, s in enumerate(sections):
        if not isinstance(s, dict):
            return _layout_err("section must be an object", section=i), None
        w = s.get("width_cm")
        if not _is_num(w) or not 10 <= w <= 300:
            return _layout_err(
                "width_cm must be a number between 10 and 300", section=i
            ), None
        zones = s.get("zones", [])
        if not isinstance(zones, list):
            return _layout_err("zones must be an array", section=i), None
        if len(zones) > 20:
            return _layout_err(
                "at most 20 zones per section are allowed", section=i
            ), None
        parsed_zones = []
        for j, z in enumerate(zones):
            if not isinstance(z, dict):
                return _layout_err("zone must be an object",
                                   section=i, zone=j), None
            kind = z.get("kind")
            if kind not in CLOSET_ZONE_KINDS:
                return _layout_err(
                    "invalid zone kind (drawer|shelf|hanging|basket|open)",
                    section=i, zone=j,
                ), None
            zh = z.get("height_cm")
            if zh is not None and (not _is_num(zh) or not 1 <= zh <= 400):
                return _layout_err(
                    "zone height_cm must be a number between 1 and 400, "
                    "or null (flex)", section=i, zone=j,
                ), None
            parsed_zones.append({
                "kind": kind,
                "height_cm": float(zh) if zh is not None else None,
                "label_en": str(z.get("label_en", "") or ""),
                "label_fa": str(z.get("label_fa", "") or ""),
                "label_da": str(z.get("label_da", "") or ""),
            })
        parsed_sections.append({
            "width_cm": float(w),
            "corner": bool(s.get("corner", False)),
            "zones": parsed_zones,
        })
    return None, {"height_cm": float(h), "sections": parsed_sections}


def _layout_payload(conn, u):
    """Canonical GET/PUT /layout response body for a unit row."""
    zones_by_col = {}
    for c in conn.execute(
        "SELECT * FROM cells WHERE unit_id=? ORDER BY col, row", (u["id"],)
    ).fetchall():
        zones_by_col.setdefault(c["col"], []).append(_serialize_cell(c))
    return {
        "unit_id": u["id"],
        "layout": u["layout"],
        "height_cm": u["height_cm"],
        "sections": [
            {
                "col": s["col_index"],
                "width_cm": s["width_cm"],
                "corner": bool(s["corner"]),
                "zones": zones_by_col.get(s["col_index"], []),
            }
            for s in conn.execute(
                "SELECT * FROM unit_sections WHERE unit_id=? "
                "ORDER BY sort, col_index", (u["id"],)
            ).fetchall()
        ],
    }


@app.route("/api/units/<int:unit_id>/layout", methods=["GET"])
def api_unit_layout_get(unit_id):
    """Closet layout of a unit. 400 for grid units (those use /cells)."""
    conn = get_db()
    try:
        u = conn.execute(
            "SELECT * FROM storage_units WHERE id=?", (unit_id,)
        ).fetchone()
        if u is None:
            return jsonify({"error": "not found"}), 404
        if u["layout"] == "grid":
            return jsonify({
                "error": "unit uses grid layout; use /api/units/<id>/cells"
            }), 400
        # layout 'none' answers {"layout":"none", "sections":[]} so the
        # frontend can probe uniformly before offering a closet editor.
        return jsonify(_layout_payload(conn, u))
    finally:
        conn.close()


@app.route("/api/units/<int:unit_id>/layout", methods=["PUT"])
def api_unit_layout_put(unit_id):
    """
    Bulk-replace a unit's closet layout (sections + zones); switches a
    layout='none' OR layout='grid' unit to 'closet' in a single transaction
    (a grid is torn down here first — see below — so the client never has to
    do a separate destructive PATCH that could leave the unit stranded).

    Zones are matched by (col=section index, row=zone index): surviving
    positions KEEP their cell id, so item_locations and NFC tags on them
    survive untouched. Dropped zones degrade their item locations to
    unit-level and lose their NFC tags; zones that turn 'open' (display-only)
    do the same. A grid unit's cells are all torn down (grid coordinates
    don't map to closet zones). All of these are reported in `warnings`.
    """
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    conn = get_db()
    try:
        u = conn.execute(
            "SELECT * FROM storage_units WHERE id=?", (unit_id,)
        ).fetchone()
        if u is None:
            return jsonify({"error": "not found"}), 404
        # Validate the whole payload BEFORE touching anything, so an invalid
        # closet body can never tear a grid down.
        err, parsed = _validate_layout_body(body)
        if err is not None:
            return err

        # New zone map: (row, col) -> zone spec.
        new_pos = {}
        for i, s in enumerate(parsed["sections"]):
            for j, z in enumerate(s["zones"]):
                new_pos[(j, i)] = z

        warnings = []
        affected_items = set()

        def _nfc_count_and_drop(cell_id):
            n = conn.execute(
                "SELECT COUNT(*) AS n FROM nfc_tags "
                "WHERE target_kind='cell' AND target_id=?", (cell_id,)
            ).fetchone()["n"]
            if n:
                db.nfc_delete_for_targets(conn, "cell", [cell_id])
            return n

        # Grid -> closet, atomically: grid coordinates don't map onto closet
        # zones, so every grid cell is torn down (items degrade to unit-level,
        # cell NFC tags drop) and the closet is built from a clean slate below.
        # Done in THIS transaction so a failure can't strand the unit between
        # a destroyed grid and an unsaved closet.
        if u["layout"] == "grid":
            for c in conn.execute(
                "SELECT * FROM cells WHERE unit_id=?", (unit_id,)
            ).fetchall():
                items_n = _degrade_cell_locations(conn, unit_id, c["id"],
                                                  affected_items)
                nfc_n = _nfc_count_and_drop(c["id"])
                if items_n or nfc_n:
                    warnings.append({
                        "type": "grid_replaced",
                        "row": c["row"], "col": c["col"],
                        "label_en": c["label_en"], "label_fa": c["label_fa"],
                        "label_da": c["label_da"], "kind": c["kind"],
                        "items_moved_to_unit": items_n,
                        "nfc_tags_removed": nfc_n,
                    })
            conn.execute("DELETE FROM cells WHERE unit_id=?", (unit_id,))

        # Existing zones (empty for a just-torn-down grid or a 'none' unit).
        existing = {
            (c["row"], c["col"]): c
            for c in conn.execute(
                "SELECT * FROM cells WHERE unit_id=?", (unit_id,)
            ).fetchall()
        }

        # 1) Dropped zones: position gone from the new layout.
        for pos, c in existing.items():
            if pos in new_pos:
                continue
            items_n = _degrade_cell_locations(conn, unit_id, c["id"],
                                              affected_items)
            nfc_n = _nfc_count_and_drop(c["id"])
            conn.execute("DELETE FROM cells WHERE id=?", (c["id"],))
            if items_n or nfc_n:
                warnings.append({
                    "type": "zone_dropped",
                    "row": pos[0], "col": pos[1],
                    "label_en": c["label_en"], "label_fa": c["label_fa"],
                    "label_da": c["label_da"], "kind": c["kind"],
                    "items_moved_to_unit": items_n,
                    "nfc_tags_removed": nfc_n,
                })

        # 2) Surviving + new zones.
        for (row, col), z in new_pos.items():
            c = existing.get((row, col))
            if c is None:
                conn.execute(
                    "INSERT INTO cells "
                    "(unit_id, row, col, row_span, col_span, "
                    " label_en, label_fa, label_da, kind, height_cm) "
                    "VALUES (?,?,?,1,1,?,?,?,?,?)",
                    (unit_id, row, col, z["label_en"], z["label_fa"],
                     z["label_da"], z["kind"], z["height_cm"]),
                )
                continue
            # Survivor: keep the cell id (locations/tags stay valid). When it
            # turns 'open' it stops being storage -> degrade + drop tags.
            if (z["kind"] == "open"
                    and _cell_trackable(c["kind"], u["layout"])):
                items_n = _degrade_cell_locations(conn, unit_id, c["id"],
                                                  affected_items)
                nfc_n = _nfc_count_and_drop(c["id"])
                if items_n or nfc_n:
                    warnings.append({
                        "type": "zone_untracked",
                        "row": row, "col": col,
                        "label_en": z["label_en"], "label_fa": z["label_fa"],
                        "label_da": z["label_da"], "kind": z["kind"],
                        "items_moved_to_unit": items_n,
                        "nfc_tags_removed": nfc_n,
                    })
            conn.execute(
                "UPDATE cells SET kind=?, height_cm=?, "
                "label_en=?, label_fa=?, label_da=? WHERE id=?",
                (z["kind"], z["height_cm"], z["label_en"], z["label_fa"],
                 z["label_da"], c["id"]),
            )

        # 3) Section geometry: full replace (order in the array = col order).
        conn.execute("DELETE FROM unit_sections WHERE unit_id=?", (unit_id,))
        for i, s in enumerate(parsed["sections"]):
            conn.execute(
                "INSERT INTO unit_sections "
                "(unit_id, col_index, width_cm, corner, sort) "
                "VALUES (?,?,?,?,?)",
                (unit_id, i, s["width_cm"], int(s["corner"]), i),
            )

        # 4) The unit itself: closet mode, no grid dims.
        conn.execute(
            "UPDATE storage_units SET layout='closet', height_cm=?, "
            "grid_rows=0, grid_cols=0 WHERE id=?",
            (parsed["height_cm"], unit_id),
        )
        for iid in affected_items:
            _ensure_one_primary(conn, iid)
        conn.commit()

        u2 = conn.execute(
            "SELECT * FROM storage_units WHERE id=?", (unit_id,)
        ).fetchone()
        out = _layout_payload(conn, u2)
        out["warnings"] = warnings
        return jsonify(out)
    finally:
        conn.close()


# Server-side closet starting points (frontend offers them; all editable).
# Shapes match the PUT /layout body so a template can be applied verbatim.
LAYOUT_TEMPLATES = [
    {
        "id": "pax_100_wardrobe",
        "name_en": "PAX 100 wardrobe",
        "name_fa": "کمد پاکس ۱۰۰",
        "name_da": "PAX 100 garderobeskab",
        "desc_en": "Editable starting point — adjust sizes and zones after applying.",
        "desc_fa": "نقطهٔ شروع قابل ویرایش — اندازه‌ها و بخش‌ها را پس از اعمال تنظیم کنید.",
        "desc_da": "Redigerbart udgangspunkt — justér mål og zoner bagefter.",
        "height_cm": 236,
        "sections": [
            {"width_cm": 100, "corner": False, "zones": [
                {"kind": "shelf", "height_cm": 38,
                 "label_en": "Top shelf", "label_fa": "قفسهٔ بالا",
                 "label_da": "Øverste hylde"},
                {"kind": "hanging", "height_cm": 150,
                 "label_en": "Hanging rail", "label_fa": "میلهٔ آویز",
                 "label_da": "Bøjlestang"},
                {"kind": "drawer", "height_cm": 24,
                 "label_en": "Drawer 1", "label_fa": "کشوی ۱",
                 "label_da": "Skuffe 1"},
                {"kind": "drawer", "height_cm": 24,
                 "label_en": "Drawer 2", "label_fa": "کشوی ۲",
                 "label_da": "Skuffe 2"},
            ]},
        ],
    },
    {
        "id": "pax_50_drawers",
        "name_en": "PAX 50 drawers",
        "name_fa": "پاکس ۵۰ کشودار",
        "name_da": "PAX 50 med skuffer",
        "desc_en": "Editable starting point — adjust sizes and zones after applying.",
        "desc_fa": "نقطهٔ شروع قابل ویرایش — اندازه‌ها و بخش‌ها را پس از اعمال تنظیم کنید.",
        "desc_da": "Redigerbart udgangspunkt — justér mål og zoner bagefter.",
        "height_cm": 236,
        "sections": [
            {"width_cm": 50, "corner": False, "zones": [
                {"kind": "drawer", "height_cm": None,
                 "label_en": f"Drawer {n}", "label_fa": f"کشوی {fa}",
                 "label_da": f"Skuffe {n}"}
                for n, fa in ((1, "۱"), (2, "۲"), (3, "۳"),
                              (4, "۴"), (5, "۵"), (6, "۶"))
            ]},
        ],
    },
    {
        "id": "pax_50_shelves",
        "name_en": "PAX 50 shelves",
        "name_fa": "پاکس ۵۰ قفسه‌دار",
        "name_da": "PAX 50 med hylder",
        "desc_en": "Editable starting point — adjust sizes and zones after applying.",
        "desc_fa": "نقطهٔ شروع قابل ویرایش — اندازه‌ها و بخش‌ها را پس از اعمال تنظیم کنید.",
        "desc_da": "Redigerbart udgangspunkt — justér mål og zoner bagefter.",
        "height_cm": 236,
        "sections": [
            {"width_cm": 50, "corner": False, "zones": [
                {"kind": "shelf", "height_cm": None,
                 "label_en": f"Shelf {n}", "label_fa": f"قفسهٔ {fa}",
                 "label_da": f"Hylde {n}"}
                for n, fa in ((1, "۱"), (2, "۲"), (3, "۳"),
                              (4, "۴"), (5, "۵"), (6, "۶"))
            ]},
        ],
    },
    {
        "id": "pax_l_100_50",
        "name_en": "L-shape PAX 100+50",
        "name_fa": "پاکس ال‌شکل ۱۰۰+۵۰",
        "name_da": "PAX 100+50 i L-form",
        "desc_en": "Editable starting point — adjust sizes and zones after applying.",
        "desc_fa": "نقطهٔ شروع قابل ویرایش — اندازه‌ها و بخش‌ها را پس از اعمال تنظیم کنید.",
        "desc_da": "Redigerbart udgangspunkt — justér mål og zoner bagefter.",
        "height_cm": 236,
        "sections": [
            {"width_cm": 100, "corner": True, "zones": [
                {"kind": "shelf", "height_cm": 38,
                 "label_en": "Top shelf", "label_fa": "قفسهٔ بالا",
                 "label_da": "Øverste hylde"},
                {"kind": "hanging", "height_cm": 198,
                 "label_en": "Hanging rail", "label_fa": "میلهٔ آویز",
                 "label_da": "Bøjlestang"},
            ]},
            {"width_cm": 50, "corner": False, "zones": [
                {"kind": "shelf", "height_cm": None,
                 "label_en": "Shelf 1", "label_fa": "قفسهٔ ۱",
                 "label_da": "Hylde 1"},
                {"kind": "shelf", "height_cm": None,
                 "label_en": "Shelf 2", "label_fa": "قفسهٔ ۲",
                 "label_da": "Hylde 2"},
                {"kind": "shelf", "height_cm": None,
                 "label_en": "Shelf 3", "label_fa": "قفسهٔ ۳",
                 "label_da": "Hylde 3"},
                {"kind": "drawer", "height_cm": 30,
                 "label_en": "Drawer 1", "label_fa": "کشوی ۱",
                 "label_da": "Skuffe 1"},
                {"kind": "drawer", "height_cm": 30,
                 "label_en": "Drawer 2", "label_fa": "کشوی ۲",
                 "label_da": "Skuffe 2"},
                {"kind": "drawer", "height_cm": 30,
                 "label_en": "Drawer 3", "label_fa": "کشوی ۳",
                 "label_da": "Skuffe 3"},
            ]},
        ],
    },
]


@app.route("/api/units/layout_templates", methods=["GET"])
def api_layout_templates():
    """Named closet starting points (plain data; apply via PUT /layout)."""
    return jsonify({"templates": LAYOUT_TEMPLATES})


# ---------------------------------------------------------------------------
# API: Open Food Facts lookup proxy (best-effort, never errors the client)
# ---------------------------------------------------------------------------

@app.route("/api/lookup/<barcode>", methods=["GET"])
def api_lookup(barcode):
    """
    Server-side best-effort Open Food Facts v2 fetch. Returns {name,brand} or
    null. NEVER errors the client: any failure / offline / miss -> 200 null.
    """
    code = normalize_barcode(barcode)
    # Real product barcodes are numeric. Reject anything else so it can never be
    # interpolated into the outbound URL (path/query injection guard).
    if not code or not code.isdigit():
        return jsonify(None)
    url = (
        f"https://world.openfoodfacts.org/api/v2/product/{code}.json"
        "?fields=product_name,brands"
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": OFF_UA})
        with urllib.request.urlopen(req, timeout=OFF_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        # Expected: offline, DNS failure, HTTP error, timeout, bad JSON.
        return jsonify(None)
    except Exception:
        app.logger.exception("unexpected error during OFF lookup for %s", code)
        return jsonify(None)

    if not isinstance(data, dict) or data.get("status") not in (1, "1"):
        return jsonify(None)
    product = data.get("product") or {}
    name = (product.get("product_name") or "").strip()
    brand = (product.get("brands") or "").strip()
    # brands can be a comma-list; keep the first for a clean prefill.
    if "," in brand:
        brand = brand.split(",")[0].strip()
    if not name and not brand:
        return jsonify(None)
    return jsonify({"name": name, "brand": brand})


# ---------------------------------------------------------------------------
# NFC: scan pipeline + tag registry API
# ---------------------------------------------------------------------------

def _display_name(row, prefix, fallback):
    """Trilingual display name: en, falling back fa then da then a fallback."""
    return (row[f"{prefix}en"] or row[f"{prefix}fa"] or row[f"{prefix}da"]
            or fallback)


def _nfc_link(fragment: str) -> str:
    """Absolute-ish URL for a notification link: <ingress base><fragment>."""
    return ha_client.link_base() + fragment


def _nfc_notify(title, message, fragment=None, device_id=None):
    """Fire-and-forget notification to the scanning phone. Never raises."""
    try:
        url = _nfc_link(fragment) if fragment else None
        ha_client.notify(title, message, url=url, device_id=device_id)
    except Exception:
        app.logger.exception("nfc notify failed")


def serialize_nfc_tag(conn: sqlite3.Connection, t: sqlite3.Row) -> dict:
    """
    Canonical NFC tag shape with resolved target display info. Exactly one of
    item/unit/cell is populated when the target still exists ('cell' also
    fills unit); room accompanies unit/cell for breadcrumbs.
    """
    out = {
        "id": t["id"],
        "tag_id": t["tag_id"],
        "name": t["name"] or "",
        "target_kind": t["target_kind"],
        "target_id": t["target_id"],
        "created_at": t["created_at"],
        "last_scanned_at": t["last_scanned_at"],
        "scan_count": t["scan_count"],
        "target_exists": False,
        "item": None,
        "unit": None,
        "cell": None,
        "room": None,
    }
    kind, tid = t["target_kind"], t["target_id"]
    unit_row = None
    if kind == "item":
        i = conn.execute(
            "SELECT id, name_en, name_fa, name_da, status, thumb_path "
            "FROM items WHERE id=?", (tid,)
        ).fetchone()
        if i is not None:
            out["target_exists"] = True
            out["item"] = {
                "id": i["id"], "name_en": i["name_en"], "name_fa": i["name_fa"],
                "name_da": i["name_da"], "status": i["status"],
                "thumb_url": _image_url(i["id"], i["thumb_path"]),
            }
    elif kind == "unit":
        unit_row = conn.execute(
            "SELECT * FROM storage_units WHERE id=?", (tid,)
        ).fetchone()
        out["target_exists"] = unit_row is not None
    elif kind == "cell":
        c = conn.execute("SELECT * FROM cells WHERE id=?", (tid,)).fetchone()
        if c is not None:
            out["target_exists"] = True
            out["cell"] = {
                "id": c["id"], "unit_id": c["unit_id"], "row": c["row"],
                "col": c["col"], "label_en": c["label_en"],
                "label_fa": c["label_fa"], "label_da": c["label_da"],
                "kind": c["kind"],
            }
            unit_row = conn.execute(
                "SELECT * FROM storage_units WHERE id=?", (c["unit_id"],)
            ).fetchone()
    if unit_row is not None:
        out["unit"] = _serialize_unit(conn, unit_row)
        r = conn.execute(
            "SELECT * FROM rooms WHERE id=?", (unit_row["room_id"],)
        ).fetchone()
        if r is not None:
            out["room"] = _serialize_room(r)
    return out


def _validate_nfc_target(conn, target_kind, target_id):
    """
    Validate an assignment target. Returns None when OK, else a (response,
    status) tuple. Business rule (Mohsen): only trackable compartments are
    assignable — in grid mode that is 'door' cells; in closet mode it is
    drawer/shelf/hanging/basket zones. 'open' (display cubby / open space)
    is never trackable storage.
    """
    if target_kind not in ("item", "unit", "cell"):
        return jsonify({"error": "invalid target_kind"}), 400
    if target_id is None:
        return jsonify({"error": "target_id required"}), 400
    if target_kind == "item":
        if fetch_item_row(conn, target_id) is None:
            return jsonify({"error": "target not found"}), 404
    elif target_kind == "unit":
        if conn.execute(
            "SELECT 1 FROM storage_units WHERE id=?", (target_id,)
        ).fetchone() is None:
            return jsonify({"error": "target not found"}), 404
    else:  # cell
        c = conn.execute(
            "SELECT c.kind AS kind, u.layout AS layout FROM cells c "
            "JOIN storage_units u ON u.id = c.unit_id WHERE c.id=?",
            (target_id,),
        ).fetchone()
        if c is None:
            return jsonify({"error": "target not found"}), 404
        if not _cell_trackable(c["kind"], c["layout"]):
            if c["layout"] == "closet":
                return jsonify(
                    {"error": "open zones cannot be assigned"}
                ), 400
            return jsonify(
                {"error": "only door cells can be assigned"}
            ), 400
    return None


def handle_tag_scan(tag_id, device_id=None, source="nfc", actor=None):
    """
    The scan pipeline. Called by the ha_client tag_scanned listener (device_id
    from the event) and by POST /api/nfc/scan (device_id None, actor = the
    ingress user). Returns a JSON-able result dict; notifications are
    fire-and-forget and NEVER make this raise.

      unknown tag        -> notify with a link to the assign screen.
      item tag           -> smart toggle: in_stock => check out (borrow row,
                            undo link), borrowed => check in; lost/archived =>
                            informational notify only.
      unit/cell tag      -> notify with a link to the unit's BROWSE view
                            (cell highlighted + auto-opened via ?cell=).
                            Never #/unit/<id>/grid — that is the grid EDITOR.
    Every scan of a registered tag bumps scan_count + last_scanned_at.
    """
    tag_id = str(tag_id).strip() if tag_id is not None else ""
    if not tag_id:
        return {"result": "error", "error": "empty tag_id"}
    quoted = urllib.parse.quote(tag_id, safe="")

    conn = get_db()
    try:
        tag = db.nfc_tag_by_tag_id(conn, tag_id)
        if tag is None:
            _nfc_notify(
                "Unknown tag",
                "This tag isn't assigned yet — tap to assign it.",
                f"#/nfc/assign?tag={quoted}", device_id,
            )
            return {"result": "unknown", "tag_id": tag_id, "source": source}

        db.nfc_touch_scan(conn, tag["id"])
        kind = tag["target_kind"]

        # ----- item tag: smart toggle ------------------------------------
        if kind == "item":
            item = fetch_item_row(conn, tag["target_id"])
            if item is None:
                _nfc_notify(
                    "Tag target missing",
                    "The item this tag pointed to was deleted — tap to reassign.",
                    f"#/nfc/assign?tag={quoted}", device_id,
                )
                return {"result": "target_missing", "tag_id": tag_id,
                        "target_kind": kind, "target_id": tag["target_id"]}
            name = _display_name(item, "name_", f"Item {item['id']}")

            if item["status"] == "in_stock":
                who = (actor or ha_client.device_display_name(device_id)
                       or "NFC")
                cur = conn.execute(
                    "INSERT INTO borrows "
                    "(item_id, borrowed_by, borrowed_by_ha, qty, note) "
                    "VALUES (?,?,?,?,?)",
                    (item["id"], who, who, 1, "NFC scan"),
                )
                borrow_id = cur.lastrowid
                conn.execute(
                    "UPDATE items SET status='borrowed', "
                    "updated_at=datetime('now') WHERE id=?", (item["id"],),
                )
                conn.commit()
                _nfc_notify(
                    name, "Checked out ✓ — tap to view or undo.",
                    f"#/item/{item['id']}?undo={borrow_id}", device_id,
                )
                return {"result": "checked_out", "tag_id": tag_id,
                        "item_id": item["id"], "borrow_id": borrow_id,
                        "status": "borrowed", "borrowed_by": who}

            if item["status"] == "borrowed":
                open_b = conn.execute(
                    "SELECT id FROM borrows WHERE item_id=? AND "
                    "returned_at IS NULL ORDER BY borrowed_at DESC, id DESC "
                    "LIMIT 1", (item["id"],),
                ).fetchone()
                if open_b is not None:
                    conn.execute(
                        "UPDATE borrows SET returned_at=datetime('now') "
                        "WHERE id=?", (open_b["id"],),
                    )
                remaining = conn.execute(
                    "SELECT COUNT(*) AS n FROM borrows WHERE item_id=? AND "
                    "returned_at IS NULL", (item["id"],),
                ).fetchone()["n"]
                if remaining == 0:
                    conn.execute(
                        "UPDATE items SET status='in_stock', "
                        "updated_at=datetime('now') "
                        "WHERE id=? AND status='borrowed'", (item["id"],),
                    )
                conn.commit()
                undo = f"?undo={open_b['id']}" if open_b is not None else ""
                _nfc_notify(
                    name, "Checked in ✓ — back in stock.",
                    f"#/item/{item['id']}{undo}", device_id,
                )
                return {"result": "checked_in", "tag_id": tag_id,
                        "item_id": item["id"],
                        "borrow_id": open_b["id"] if open_b else None,
                        "status": "in_stock" if remaining == 0 else "borrowed"}

            # lost / archived: informational only.
            _nfc_notify(
                name,
                f"Status is '{item['status']}' — no action taken. Tap to view.",
                f"#/item/{item['id']}", device_id,
            )
            return {"result": "info", "tag_id": tag_id,
                    "item_id": item["id"], "status": item["status"]}

        # ----- unit / cell tag: location ping -----------------------------
        cell = None
        if kind == "cell":
            cell = conn.execute(
                "SELECT * FROM cells WHERE id=?", (tag["target_id"],)
            ).fetchone()
            unit = None if cell is None else conn.execute(
                "SELECT * FROM storage_units WHERE id=?", (cell["unit_id"],)
            ).fetchone()
        else:
            unit = conn.execute(
                "SELECT * FROM storage_units WHERE id=?", (tag["target_id"],)
            ).fetchone()
        if unit is None:
            _nfc_notify(
                "Tag target missing",
                "The place this tag pointed to was deleted — tap to reassign.",
                f"#/nfc/assign?tag={quoted}", device_id,
            )
            return {"result": "target_missing", "tag_id": tag_id,
                    "target_kind": kind, "target_id": tag["target_id"]}

        unit_name = _display_name(unit, "name_", f"Unit {unit['id']}")
        title = f"\U0001F4CD {unit_name}"
        if cell is not None:
            label = _display_name(cell, "label_", f"cell {cell['id']}")
            title += f" · {label}"
        # Browse view, same as the in-app QR path (app.js nfcQuickScan):
        # #/unit/<id>/grid is the grid editor and must never be a scan target.
        frag = f"#/browse/unit/{unit['id']}"
        if cell is not None:
            frag += f"?cell={cell['id']}"
        _nfc_notify(title, "Tap to open this storage place.", frag, device_id)
        return {"result": "location", "tag_id": tag_id,
                "unit_id": unit["id"],
                "cell_id": cell["id"] if cell is not None else None}
    finally:
        conn.close()


@app.route("/api/nfc/tags", methods=["GET"])
def api_nfc_tags_list():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM nfc_tags ORDER BY created_at DESC, id DESC"
        ).fetchall()
        return jsonify({"tags": [serialize_nfc_tag(conn, t) for t in rows]})
    finally:
        conn.close()


@app.route("/api/nfc/tags", methods=["POST"])
def api_nfc_tag_create():
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    tag_id = str(body.get("tag_id") or "").strip()
    if not tag_id:
        return jsonify({"error": "tag_id required"}), 400
    name = str(body.get("name") or "").strip()
    target_kind = body.get("target_kind")
    target_id = as_int(body.get("target_id"), None)

    conn = get_db()
    try:
        err = _validate_nfc_target(conn, target_kind, target_id)
        if err is not None:
            return err
        existing = db.nfc_tag_by_tag_id(conn, tag_id)
        if existing is not None:
            # 409 carries the current assignment so the UI can offer reassign.
            return jsonify({
                "error": "tag already assigned",
                "existing": serialize_nfc_tag(conn, existing),
            }), 409
        cur = conn.execute(
            "INSERT INTO nfc_tags (tag_id, name, target_kind, target_id) "
            "VALUES (?,?,?,?)",
            (tag_id, name, target_kind, target_id),
        )
        conn.commit()
        t = conn.execute(
            "SELECT * FROM nfc_tags WHERE id=?", (cur.lastrowid,)
        ).fetchone()
        return jsonify(serialize_nfc_tag(conn, t)), 201
    finally:
        conn.close()


@app.route("/api/nfc/tags/<int:nfc_id>", methods=["PATCH"])
def api_nfc_tag_update(nfc_id):
    """Rename and/or retarget an assignment (same validations as create)."""
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    conn = get_db()
    try:
        t = conn.execute(
            "SELECT * FROM nfc_tags WHERE id=?", (nfc_id,)
        ).fetchone()
        if t is None:
            return jsonify({"error": "not found"}), 404

        sets, params = [], []
        if "name" in body:
            sets.append("name = ?")
            params.append(str(body.get("name") or "").strip())
        if "target_kind" in body or "target_id" in body:
            new_kind = body.get("target_kind", t["target_kind"])
            new_id = as_int(body.get("target_id", t["target_id"]), None)
            err = _validate_nfc_target(conn, new_kind, new_id)
            if err is not None:
                return err
            sets.append("target_kind = ?")
            params.append(new_kind)
            sets.append("target_id = ?")
            params.append(new_id)
        if sets:
            params.append(nfc_id)
            conn.execute(
                f"UPDATE nfc_tags SET {', '.join(sets)} WHERE id=?", params
            )
            conn.commit()
        t2 = conn.execute(
            "SELECT * FROM nfc_tags WHERE id=?", (nfc_id,)
        ).fetchone()
        return jsonify(serialize_nfc_tag(conn, t2))
    finally:
        conn.close()


@app.route("/api/nfc/tags/<int:nfc_id>", methods=["DELETE"])
def api_nfc_tag_delete(nfc_id):
    conn = get_db()
    try:
        cur = conn.execute("DELETE FROM nfc_tags WHERE id=?", (nfc_id,))
        conn.commit()
        if cur.rowcount == 0:
            return jsonify({"error": "not found"}), 404
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.route("/api/nfc/resolve/<tag_id>", methods=["GET"])
def api_nfc_resolve(tag_id):
    """Assignment for a physical tag id, or {assigned: false}."""
    conn = get_db()
    try:
        t = db.nfc_tag_by_tag_id(conn, str(tag_id).strip())
        if t is None:
            return jsonify({"assigned": False, "tag_id": tag_id})
        return jsonify({"assigned": True, "tag": serialize_nfc_tag(conn, t)})
    finally:
        conn.close()


@app.route("/api/nfc/ha_tags", methods=["GET"])
def api_nfc_ha_tags():
    """Tags registered in Home Assistant (empty list when offline)."""
    return jsonify({
        "tags": ha_client.ha_tags(),
        "ha_available": ha_client.ha_available(),
    })


@app.route("/api/nfc/scan", methods=["POST"])
def api_nfc_scan():
    """
    Frontend/dev entry into the scan pipeline (QR fallback, simulation).
    Body: {tag_id, source?}. The acting user is the ingress user, so borrows
    from here are attributed to them rather than to a scanning device.
    """
    body = json_body()
    if body is None:
        return jsonify({"error": "invalid json body"}), 400
    tag_id = str(body.get("tag_id") or "").strip()
    if not tag_id:
        return jsonify({"error": "tag_id required"}), 400
    source = str(body.get("source") or "manual")
    result = handle_tag_scan(tag_id, device_id=None, source=source,
                             actor=current_user())
    return jsonify(result)


# ---------------------------------------------------------------------------
# API: admin reset / clear (ADDENDA §4)
# ---------------------------------------------------------------------------

@app.route("/api/admin/reset", methods=["POST"])
def api_admin_reset():
    """Wipe all tables, then re-run the seed.

    Image dirs are left as-is; orphaned dirs are harmless and rare in dev.
    """
    conn = get_db()
    try:
        db.wipe_all(conn)
        db.seed(conn, normalize)
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.route("/api/admin/clear", methods=["POST"])
def api_admin_clear():
    """Wipe all tables, no seed (empty app)."""
    conn = get_db()
    try:
        db.wipe_all(conn)
        return jsonify({"ok": True})
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Error handlers — always JSON for /api/* paths
# ---------------------------------------------------------------------------

@app.errorhandler(413)
def handle_413(e):
    return jsonify({"error": "file too large"}), 413


@app.errorhandler(404)
def handle_404(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": "not found"}), 404
    return e, 404


@app.errorhandler(500)
def handle_500(e):
    if request.path.startswith("/api/"):
        return jsonify({"error": "internal error"}), 500
    return e, 500


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

# Initialize DB at import time so test_client() (no __main__) works too.
init_db()


if __name__ == "__main__":
    from waitress import serve
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s: %(message)s",
    )
    mode = "DEV" if DEV_MODE else "PROD"
    print(f"Home Inventory starting in {mode} mode; DATA_DIR={DATA_DIR}; "
          f"HA connectivity: {ha_client.MODE}")
    # NFC scans: HA fires tag_scanned (companion app); the listener feeds the
    # scan pipeline. No-op in offline mode; reconnects forever otherwise.
    ha_client.start_listener(
        lambda tag_id, device_id: handle_tag_scan(
            tag_id, device_id=device_id, source="nfc"
        )
    )
    serve(app, host="0.0.0.0", port=8099, threads=8)
