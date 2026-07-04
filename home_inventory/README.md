# Home Inventory — Home Assistant add-on

Find where everything is in your home. A search-first inventory app that maps your
rooms → storage units → individual compartments, so a search for something tells you
exactly where it is (e.g. **Entrance › Pigeon-hole shelf › D4**) and lights up that
cell on a schematic map.

Runs as a local Home Assistant **Ingress** add-on: it appears in the HA sidebar, is
authenticated by HA automatically (no extra login), works in the HA companion app and
over your remote URL, and stores all data inside the add-on (survives restarts and
updates).

## What's new in v2.0

- **Full visual redesign** — a warm editorial look (paper tones, Fraunces serif,
  sage + terracotta) replaces the plain v1 UI.
- **Closet layouts** — units are no longer limited to a uniform grid. Wardrobes and
  closets are now mapped as to-scale **sections & zones** (shelves, hanging rails,
  drawers, baskets) with a live **composer** and ready-made templates (incl. an
  L-shaped PAX). Grid shelves still work exactly as before.
- **Clearer add-item flow** — the barcode is shown on the form and every field
  validates inline (no more silent "nothing happened").

## Features

- **Trilingual** — English / فارسی / Dansk everywhere, with full **right-to-left**
  layout for Persian and smart search normalisation (ک/ك, ی/ي, Persian/Arabic digits,
  ZWNJ, Danish æ/ø/å).
- **Instant fuzzy search** across all three languages + brand + tags + barcode, with
  match highlighting — and a **Places** group when your query matches a room, unit or
  compartment name.
- **To-scale storage maps** of every unit. **Grid shelves** have compartments that are
  either **door** (closed, trackable storage) or **open** (exposed display). **Closets**
  are drawn as real **sections & zones** — shelves, hanging rails, drawers and baskets,
  sized in centimetres — so a search highlights the exact drawer or shelf an item is in.
- **Closet composer** — map a wardrobe from a template (incl. an L-shaped PAX) or from
  scratch: add sections and zones, set widths and heights, and watch a live to-scale
  blueprint update as you go.
- **Barcode & QR scanning** with the phone camera (fully offline; optional online
  product-name lookup when internet is available).
- **NFC tags** — assign a Home Assistant tag to an item, a unit or a door
  compartment. Scanning an item tag smart-toggles it (check out ↔ check in); scanning
  a place tag opens that spot on the map. See below.
- **Borrow tracking** — who has what, since when, when it's due, one-tap return.
- **Per-item photos** (auto-thumbnailed), quantities, categories, tags, notes.
- **Warm editorial design** — paper tones, a Fraunces serif display face and a sage +
  terracotta palette — with light/dark modes, large tap targets and screen-reader support.

## First run — starts empty

The app seeds **structure only**, no demo items:

- **7 rooms** — Entrance, Living room, Kitchen, Bedroom, Office, Bathroom, Store-room
  (each with English/Persian/Danish names).
- The Entrance **Pigeon-hole shelf** as a 6×6 grid (labels A1–F6): 14 door
  compartments, the rest open display cells — edit the layout in the grid editor.
- A **Wardrobe** in the Bedroom, ready to map as a closet (sections & zones).

Your inventory starts at zero items; add the first one with the camera button.
The **⋮ menu** offers **Reset structure (rooms & pigeon-hole)** — deletes everything
and rebuilds this starting structure — and **Clear everything** for a completely
blank app. Both ask for confirmation.

## NFC tags

The add-on plugs into Home Assistant's tag system — no extra hardware beyond
ordinary NFC stickers.

**Setup**

1. Write/register the tag with the **HA companion app** (Settings → Tags → Add tag).
   Companion-written tags carry a `https://www.home-assistant.io/tag/<id>` URL.
2. In Home Inventory: **⋮ menu → NFC tags → Assign**. Enter the tag id by picking it
   from HA's tag registry, reading it with the phone's NFC (Chrome/Android), or
   scanning its QR — then choose the target: an **item**, a whole **unit**, or a
   single **door compartment**.

**What a scan does** (smart toggle)

| Tag target | Item status | Result |
|---|---|---|
| Item | in stock | Checked **out** (borrower = whoever scanned) |
| Item | borrowed | Checked **in** |
| Item | lost / archived | Notification only, nothing changes |
| Unit / compartment | — | Opens that spot on the schematic map |
| Unregistered tag | — | Link to the assign screen |

Each scan sends a **push notification to the phone that scanned**, deep-linking into
the app (with one-tap **Undo** for check-out/in).

**Requirements:** physical scans arrive as HA `tag_scanned` events, so scanning a
sticker requires the **HA companion app** on the phone (the add-on listens on the HA
websocket — `homeassistant_api` is already declared in `config.yaml`). Phones without
NFC can scan a tag's **QR code** from the in-app scanner instead; registered tag ids
are recognised there too.

## Install on Home Assistant (HAOS / Supervised)

> Placeholder — this add-on will be installed from a **GitHub add-on repository**.
> The final repository URL will be added here at install time.

1. In HA go to **Settings → Add-ons → Add-on Store → ⋮ → Repositories** and add the
   repository URL: `<repository URL — to be added>`.
2. Refresh the store, open **Home Inventory** → **Install** (first build needs
   internet once).
3. Enable **Start on boot** (and **Watchdog** if you like) → **Start**.
4. Open **Inventory** in the sidebar (visible to all HA users, not just admins).
5. In the companion app, grant the OS **camera permission** so scanning works.

## Your data

Everything lives under the add-on's persistent `/data` directory:
`/data/inventory.db` (SQLite) and `/data/images/…` (photos + thumbnails). It survives
add-on restarts and updates; schema changes are applied as in-place migrations. Back
it up by copying `/data` or via HA's add-on backup.

## Run locally (dev mode)

```bash
# from inside the home_inventory folder, with requirements.txt installed
INVENTORY_DEV=1 python server.py        # then open http://localhost:8099/
```

Dev mode stores data in a local `./data` folder, skips the Ingress IP allowlist and
serves the SPA at the web root. NFC extras in dev: with `HA_URL` + `HA_TOKEN` in the
environment (or `../.env`) the add-on talks to a real HA over websocket; set
`INVENTORY_NO_HA=1` to force fully-offline behaviour (everything else keeps working).

## How it's built

- **Backend:** Python (Flask + waitress), stdlib `sqlite3`, Pillow for thumbnails —
  one file per concern (`server.py`, `db.py`, `normalize.py`, `ha_client.py`).
- **Frontend:** a no-build vanilla-JS single-page app (`www/`), with Fuse.js
  (search), a zxing-wasm barcode scanner and the Vazirmatn Persian font — all
  vendored in `www/vendor/` so the app needs **no internet at runtime**.
- **Ingress-correct:** every URL is relative and the SPA's `<base href>` is set from
  HA's `X-Ingress-Path`, so it works under HA's proxied path, in the companion app
  and locally.
