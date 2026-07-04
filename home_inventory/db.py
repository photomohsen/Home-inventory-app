"""
db.py — SQLite connection helper, schema DDL, and first-run seed routine.

- Every connection: PRAGMA journal_mode=WAL, PRAGMA foreign_keys=ON.
- Schema is the full BUILD_SPEC §4 DDL.
- seed_if_empty() runs only when the rooms table is empty (idempotent),
  building the realistic starting structure from ADDENDA §4.
"""

import os
import sqlite3

# ---------------------------------------------------------------------------
# Schema (BUILD_SPEC §4) — verbatim DDL.
# ---------------------------------------------------------------------------

SCHEMA_SQL = """
-- Rooms (e.g. living_room, kitchen). Trilingual display names.
CREATE TABLE IF NOT EXISTS rooms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en     TEXT NOT NULL DEFAULT '',
  name_fa     TEXT NOT NULL DEFAULT '',
  name_da     TEXT NOT NULL DEFAULT '',
  icon        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Storage units inside a room (e.g. "Tool cabinet", "Pantry shelf").
-- layout: 'grid'   = uniform rows x cols grid of cells (grid_rows/grid_cols > 0);
--         'closet' = vertical sections (unit_sections) stacked with zones
--                    (cells: col = section index, row = zone index, top = 0);
--         'none'   = no internal layout (plain unit).
-- height_cm: physical height (closet mode; nullable).
CREATE TABLE IF NOT EXISTS storage_units (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id     INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name_en     TEXT NOT NULL DEFAULT '',
  name_fa     TEXT NOT NULL DEFAULT '',
  name_da     TEXT NOT NULL DEFAULT '',
  grid_rows   INTEGER NOT NULL DEFAULT 0,
  grid_cols   INTEGER NOT NULL DEFAULT 0,
  layout      TEXT NOT NULL DEFAULT 'none' CHECK (layout IN ('grid','closet','none')),
  height_cm   REAL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_units_room ON storage_units(room_id);

-- Closet sections (layout='closet'): vertical columns left->right.
-- col_index matches cells.col for the zones inside the section.
CREATE TABLE IF NOT EXISTS unit_sections (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id     INTEGER NOT NULL REFERENCES storage_units(id) ON DELETE CASCADE,
  col_index   INTEGER NOT NULL,
  width_cm    REAL NOT NULL,
  corner      INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(unit_id, col_index)
);
CREATE INDEX IF NOT EXISTS idx_sections_unit ON unit_sections(unit_id);

-- Cells = individual compartments in a unit's grid, OR zones in a closet
-- section (col = section index, row = zone index within the section, 0 = top).
-- kind (grid):   'door' = closed compartment (trackable storage, assignable);
--                'open' = exposed display cubby (NOT storage, not assignable).
-- kind (closet): 'drawer'|'shelf'|'hanging'|'basket' = trackable zones;
--                'open' = open space, display-only (same rule as grid 'open').
-- height_cm: zone height in cm (closet mode); NULL = flex / equal share.
CREATE TABLE IF NOT EXISTS cells (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id     INTEGER NOT NULL REFERENCES storage_units(id) ON DELETE CASCADE,
  row         INTEGER NOT NULL,
  col         INTEGER NOT NULL,
  row_span    INTEGER NOT NULL DEFAULT 1,
  col_span    INTEGER NOT NULL DEFAULT 1,
  label_en    TEXT NOT NULL DEFAULT '',
  label_fa    TEXT NOT NULL DEFAULT '',
  label_da    TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'door'
              CHECK (kind IN ('door','open','drawer','shelf','hanging','basket')),
  height_cm   REAL,
  UNIQUE(unit_id, row, col)
);
CREATE INDEX IF NOT EXISTS idx_cells_unit ON cells(unit_id);

-- Items.
CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en       TEXT NOT NULL DEFAULT '',
  name_fa       TEXT NOT NULL DEFAULT '',
  name_da       TEXT NOT NULL DEFAULT '',
  brand         TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  qty           INTEGER NOT NULL DEFAULT 1,
  tags          TEXT NOT NULL DEFAULT '[]',
  barcode       TEXT,
  barcode_format TEXT,
  photo_path    TEXT,
  thumb_path    TEXT,
  status        TEXT NOT NULL DEFAULT 'in_stock'
                  CHECK (status IN ('in_stock','borrowed','lost','archived')),
  search        TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode);
CREATE INDEX IF NOT EXISTS idx_items_status  ON items(status);

-- An item can live in one or more cells (or just a unit if it has no grid).
CREATE TABLE IF NOT EXISTS item_locations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  unit_id     INTEGER NOT NULL REFERENCES storage_units(id) ON DELETE CASCADE,
  cell_id     INTEGER REFERENCES cells(id) ON DELETE SET NULL,
  qty_here    INTEGER NOT NULL DEFAULT 1,
  is_primary  INTEGER NOT NULL DEFAULT 1,
  UNIQUE(item_id, unit_id, cell_id)
);
CREATE INDEX IF NOT EXISTS idx_loc_item ON item_locations(item_id);
CREATE INDEX IF NOT EXISTS idx_loc_unit ON item_locations(unit_id);
CREATE INDEX IF NOT EXISTS idx_loc_cell ON item_locations(cell_id);

-- Borrow / check-out history. Open borrow = returned_at IS NULL.
CREATE TABLE IF NOT EXISTS borrows (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  borrowed_by   TEXT NOT NULL DEFAULT '',
  borrowed_by_ha TEXT,
  qty           INTEGER NOT NULL DEFAULT 1,
  borrowed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  due_at        TEXT,
  returned_at   TEXT,
  note          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_borrows_item ON borrows(item_id);
CREATE INDEX IF NOT EXISTS idx_borrows_open ON borrows(item_id) WHERE returned_at IS NULL;

-- NFC tags (iteration 3): a physical tag maps to an item, a storage unit, or
-- a single 'door' cell (business rule: only closed compartments are trackable,
-- enforced in server.py). No FK on target_id — it can point at three different
-- parent tables — so the server's delete paths clean up assignments explicitly
-- via db.nfc_delete_for_targets().
CREATE TABLE IF NOT EXISTS nfc_tags (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id          TEXT NOT NULL UNIQUE,
  name            TEXT DEFAULT '',
  target_kind     TEXT NOT NULL CHECK (target_kind IN ('item','unit','cell')),
  target_id       INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_scanned_at TEXT,
  scan_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_nfc_target ON nfc_tags(target_kind, target_id);

-- Barcode lookup cache (best-effort product data from the external keyless
-- chain). Positive hits only, so a repeat scan is instant and never re-burns
-- the UPCitemdb daily quota. Not user data — safe to clear any time.
CREATE TABLE IF NOT EXISTS barcode_cache (
  barcode    TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  brand      TEXT NOT NULL DEFAULT '',
  image      TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

# All tables, for admin wipe (children first so cascade/order is harmless).
ALL_TABLES = (
    "nfc_tags",
    "borrows",
    "item_locations",
    "items",
    "cells",
    "unit_sections",
    "storage_units",
    "rooms",
)


def connect(db_path: str) -> sqlite3.Connection:
    """Open a connection with WAL + foreign keys, rows as dict-like sqlite3.Row."""
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    """True if `column` is present on `table` (via PRAGMA table_info)."""
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r["name"] == column for r in rows)


# The post-closet-migration cells table. Must stay in sync with the `cells`
# definition in SCHEMA_SQL above (used by the rename-copy-swap rebuild that
# widens the kind CHECK — SQLite cannot ALTER a CHECK constraint in place).
_CELLS_REBUILD_DDL = """
CREATE TABLE cells_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id     INTEGER NOT NULL REFERENCES storage_units(id) ON DELETE CASCADE,
  row         INTEGER NOT NULL,
  col         INTEGER NOT NULL,
  row_span    INTEGER NOT NULL DEFAULT 1,
  col_span    INTEGER NOT NULL DEFAULT 1,
  label_en    TEXT NOT NULL DEFAULT '',
  label_fa    TEXT NOT NULL DEFAULT '',
  label_da    TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'door'
              CHECK (kind IN ('door','open','drawer','shelf','hanging','basket')),
  height_cm   REAL,
  UNIQUE(unit_id, row, col)
)
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """
    Idempotent, defensive migrations for DBs created by an older schema.

    cells.kind (iteration 2): a pre-existing `cells` table (created before the
    column existed) is not recreated by CREATE TABLE IF NOT EXISTS, so add the
    column here. ALTER ... ADD COLUMN with a non-NULL default backfills every
    existing row to 'door'. No-op on a fresh or already-migrated DB.

    nfc_tags (iteration 3) / unit_sections (closet layouts) need no entry here:
    brand-new TABLES are added to existing production DBs by the CREATE TABLE
    IF NOT EXISTS in SCHEMA_SQL (run on every startup).

    Closet layouts:
      1. storage_units gains layout ('grid'|'closet'|'none') + height_cm via
         ALTER; existing rows are mapped grid_rows>0 -> 'grid', else 'none'.
      2. cells gains height_cm AND a widened kind CHECK (closet zone kinds).
         SQLite cannot alter a CHECK, so this is a rename-copy-swap rebuild
         preserving row ids (item_locations.cell_id / nfc_tags cell targets
         keep working). Runs with foreign_keys=OFF inside one transaction,
         then verifies with PRAGMA foreign_key_check.
    """
    if not _column_exists(conn, "cells", "kind"):
        conn.execute(
            "ALTER TABLE cells ADD COLUMN kind TEXT NOT NULL DEFAULT 'door'"
        )
        conn.commit()

    # --- storage_units: layout + height_cm --------------------------------
    if not _column_exists(conn, "storage_units", "layout"):
        conn.execute(
            "ALTER TABLE storage_units ADD COLUMN layout TEXT NOT NULL "
            "DEFAULT 'none' CHECK (layout IN ('grid','closet','none'))"
        )
        # Map existing rows: a unit with a grid keeps behaving as a grid.
        conn.execute(
            "UPDATE storage_units SET layout='grid' WHERE grid_rows > 0"
        )
        conn.commit()
    if not _column_exists(conn, "storage_units", "height_cm"):
        conn.execute("ALTER TABLE storage_units ADD COLUMN height_cm REAL")
        conn.commit()

    # --- cells: height_cm + widened kind CHECK (table rebuild) ------------
    if not _column_exists(conn, "cells", "height_cm"):
        conn.commit()  # close any implicit transaction before the PRAGMA
        conn.execute("PRAGMA foreign_keys=OFF")
        try:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute(_CELLS_REBUILD_DDL)
            conn.execute(
                "INSERT INTO cells_new "
                "(id, unit_id, row, col, row_span, col_span, "
                " label_en, label_fa, label_da, kind, height_cm) "
                "SELECT id, unit_id, row, col, row_span, col_span, "
                "       label_en, label_fa, label_da, kind, NULL FROM cells"
            )
            conn.execute("DROP TABLE cells")
            conn.execute("ALTER TABLE cells_new RENAME TO cells")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_cells_unit ON cells(unit_id)"
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.execute("PRAGMA foreign_keys=ON")
        bad = conn.execute("PRAGMA foreign_key_check").fetchall()
        if bad:
            raise RuntimeError(
                "foreign_key_check failed after cells rebuild: "
                + repr([tuple(r) for r in bad])
            )


def init_schema(conn: sqlite3.Connection) -> None:
    """Create all tables/indexes if they don't exist, then run migrations."""
    conn.executescript(SCHEMA_SQL)
    conn.commit()
    _migrate(conn)


def wipe_all(conn: sqlite3.Connection) -> None:
    """Delete every row from every table (admin clear/reset). Keeps schema."""
    cur = conn.cursor()
    for table in ALL_TABLES:
        cur.execute(f"DELETE FROM {table}")
    # Reset AUTOINCREMENT counters so a reset looks like a fresh install.
    cur.execute(
        "DELETE FROM sqlite_sequence WHERE name IN "
        "('rooms','storage_units','unit_sections','cells','items',"
        "'item_locations','borrows','nfc_tags')"
    )
    conn.commit()


# ---------------------------------------------------------------------------
# NFC tag helpers
# ---------------------------------------------------------------------------

def nfc_tag_by_tag_id(conn: sqlite3.Connection, tag_id: str):
    """The nfc_tags row for a physical tag id, or None."""
    return conn.execute(
        "SELECT * FROM nfc_tags WHERE tag_id=?", (tag_id,)
    ).fetchone()


def nfc_touch_scan(conn: sqlite3.Connection, nfc_id: int) -> None:
    """Record a scan: bump scan_count and stamp last_scanned_at. Commits."""
    conn.execute(
        "UPDATE nfc_tags SET last_scanned_at=datetime('now'), "
        "scan_count=scan_count+1 WHERE id=?",
        (nfc_id,),
    )
    conn.commit()


def nfc_delete_for_targets(conn: sqlite3.Connection, target_kind: str,
                           target_ids) -> None:
    """
    Remove tag assignments pointing at deleted targets. nfc_tags has no FK
    (target_id can reference items, storage_units or cells), so the server's
    delete paths call this explicitly. Does NOT commit (caller's transaction).
    """
    ids = [i for i in target_ids if i is not None]
    if not ids:
        return
    placeholders = ",".join("?" * len(ids))
    conn.execute(
        f"DELETE FROM nfc_tags WHERE target_kind=? AND target_id IN ({placeholders})",
        [target_kind, *ids],
    )


# ---------------------------------------------------------------------------
# Seed (ADDENDA §4) — only when rooms is empty.
# ---------------------------------------------------------------------------

# Rooms: (name_en, name_fa, name_da, icon)
_SEED_ROOMS = [
    ("Entrance",    "ورودی",       "Entré",        "mdi:door"),
    ("Living room", "اتاق نشیمن",  "Stue",         "mdi:sofa"),
    ("Kitchen",     "آشپزخانه",    "Køkken",       "mdi:silverware-fork-knife"),
    ("Bedroom",     "اتاق خواب",   "Soveværelse",  "mdi:bed"),
    ("Office",      "دفتر کار",    "Kontor",       "mdi:desk"),
    ("Bathroom",    "حمام",        "Badeværelse",  "mdi:shower"),
    ("Store-room",  "انباری",      "Pulterrum",    "mdi:archive"),
]

# Entrance pigeon-hole DOOR map (iteration 2): these (row,col) cells are closed,
# trackable "door" compartments. Every other cell in the 6x6 grid is 'open'
# (exposed display — not storage). 0-based; row 0 = top, col 0 = A. 14 doors.
_ENTRANCE_DOORS = {
    (0, 1), (0, 2), (0, 4),
    (1, 0), (1, 3),
    (2, 2), (2, 4),
    (3, 0), (3, 4), (3, 5),
    (4, 3), (4, 5),
    (5, 1), (5, 4),
}


def _cell_label(row: int, col: int) -> str:
    """Coordinate label: col letter A–F by col, row number 1–6 by row. e.g. (1,2)->'C2'."""
    return f"{chr(ord('A') + col)}{row + 1}"


def is_empty(conn: sqlite3.Connection) -> bool:
    """True when the rooms table has no rows (first-run condition)."""
    return conn.execute("SELECT COUNT(*) AS n FROM rooms").fetchone()["n"] == 0


def seed_if_empty(conn: sqlite3.Connection, normalize) -> bool:
    """
    Idempotent first-run seed. Returns True if seeding ran, False if skipped.
    `normalize` is passed in (the project's normalize()) to compute items.search.
    """
    if not is_empty(conn):
        return False
    seed(conn, normalize)
    return True


def seed(conn: sqlite3.Connection, normalize) -> None:
    """
    Build the starting structure (iteration 2): 7 rooms, the Entrance 6x6
    pigeon-hole (door/open kinds from the door map), and the Bedroom Wardrobe
    (no grid). NO demo items — the app starts empty. Assumes empty tables.

    `normalize` is accepted for API stability (no items to index in this seed).
    """
    cur = conn.cursor()

    # --- Rooms (in order; sort_order follows the list) ---
    room_ids = {}
    for i, (en, fa, da, icon) in enumerate(_SEED_ROOMS):
        cur.execute(
            "INSERT INTO rooms (name_en, name_fa, name_da, icon, sort_order) "
            "VALUES (?,?,?,?,?)",
            (en, fa, da, icon, i),
        )
        room_ids[en] = cur.lastrowid

    # --- Entrance: 6x6 "Pigeon-hole shelf" with auto-created 36 cells ---
    cur.execute(
        "INSERT INTO storage_units "
        "(room_id, name_en, name_fa, name_da, grid_rows, grid_cols, layout, "
        " sort_order) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (room_ids["Entrance"], "Pigeon-hole shelf", "قفسهٔ کبوترخانه",
         "Reol med rum", 6, 6, "grid", 0),
    )
    pigeon_id = cur.lastrowid

    # Auto-create all 36 cells; label_en = coordinate (fa/da empty, language-neutral).
    # kind = 'door' for cells in the door map, else 'open'.
    for row in range(6):
        for col in range(6):
            kind = "door" if (row, col) in _ENTRANCE_DOORS else "open"
            cur.execute(
                "INSERT INTO cells "
                "(unit_id, row, col, row_span, col_span, label_en, label_fa, label_da, kind) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (pigeon_id, row, col, 1, 1, _cell_label(row, col), "", "", kind),
            )

    # --- Bedroom: non-grid "Wardrobe" (demonstrates no-grid / chip fallback) ---
    cur.execute(
        "INSERT INTO storage_units "
        "(room_id, name_en, name_fa, name_da, grid_rows, grid_cols, layout, "
        " sort_order) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (room_ids["Bedroom"], "Wardrobe", "کمد لباس", "Garderobe", 0, 0,
         "none", 0),
    )

    conn.commit()
