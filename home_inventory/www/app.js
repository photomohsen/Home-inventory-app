// app.js — Home Inventory SPA.
// Hash router + central state + bootstrap load + Fuse.js search + all six screens.
// All URLs RELATIVE (no leading slash); api() resolves against document.baseURI.

import Fuse from './vendor/fuse.min.mjs';
import { normalize } from './normalize.js';
import { t, tCount, setLang, getLang, LANGS, LANG_LABELS } from './i18n.js';
import { openScanner, normalizeBarcode } from './scan.js';

/* ============================================================ *
 *  API helper — single source of truth for all network calls.  *
 * ============================================================ */
const api = (p, o) => fetch(new URL('api/' + p, document.baseURI), o);

async function apiJSON(p, o) {
  const res = await api(p, o);
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}
const apiGet = (p) => apiJSON(p);
const apiSend = (method, p, body) => apiJSON(p, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body == null ? undefined : JSON.stringify(body),
});

// Like apiSend but resolves {ok, status, data} instead of throwing on HTTP errors,
// so callers can act on structured error bodies (e.g. the NFC 409 "already
// assigned" payload, which carries the existing assignment). Network failures
// still throw — catch those like any other apiSend call.
async function apiSendRaw(method, p, body) {
  const res = await api(p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { ok: res.ok, status: res.status, data };
}

/* ============================================================ *
 *  Central state                                               *
 * ============================================================ */
const state = {
  user: '',
  rooms: [],
  units: [],
  cells: [],
  items: [],
  borrows_open: [],
  nfc_tags: [],
  ha_available: false,
  // lookup maps (rebuilt on load)
  roomById: new Map(),
  unitById: new Map(),
  cellById: new Map(),
  itemById: new Map(),
  fuse: null,
  placesFuse: null,
  loaded: false,
};

function rebuildIndexes() {
  state.roomById = new Map(state.rooms.map(r => [r.id, r]));
  state.unitById = new Map(state.units.map(u => [u.id, u]));
  state.cellById = new Map(state.cells.map(c => [c.id, c]));
  state.itemById = new Map(state.items.map(i => [i.id, i]));
}

function buildFuse() {
  // Items already carry a precomputed normalized `search` blob from the server,
  // but we still normalize fa/da name getters and ALWAYS normalize the query.
  state.fuse = new Fuse(state.items, {
    keys: [
      { name: 'name_en', weight: 0.9 },
      { name: 'name_fa', weight: 0.9, getFn: it => normalize(it.name_fa) },
      { name: 'name_da', weight: 0.9, getFn: it => normalize(it.name_da) },
      { name: 'brand', weight: 0.7 },
      { name: 'tags', weight: 0.5 },
      { name: 'barcode', weight: 0.8 },
      { name: 'search', weight: 1.0 },
    ],
    threshold: 0.3,
    ignoreLocation: true,
    includeMatches: true,
    includeScore: true,
    minMatchCharLength: 2,
    isCaseSensitive: false,
    shouldSort: true,
  });
}

function runSearch(q) {
  if (!state.fuse) return [];
  return state.fuse.search(normalize(q));
}

// Places index (rooms / units / labelled cells) so searches like "pigeon-hole"
// or "ورودی" surface the place itself, not just items stored in it. Client-side
// only — everything needed is already in bootstrap. Same key pattern as the
// items index: en raw, fa/da via normalized getFns, query always normalized.
function buildPlacesFuse() {
  const places = [];
  state.rooms.forEach(r => places.push({
    kind: 'room', ref: r,
    name_en: r.name_en || '', name_fa: r.name_fa || '', name_da: r.name_da || '',
  }));
  state.units.forEach(u => places.push({
    kind: 'unit', ref: u,
    name_en: u.name_en || '', name_fa: u.name_fa || '', name_da: u.name_da || '',
  }));
  state.cells.forEach(c => {
    if (!c.label_en && !c.label_fa && !c.label_da) return;
    places.push({
      kind: 'cell', ref: c,
      name_en: c.label_en || '', name_fa: c.label_fa || '', name_da: c.label_da || '',
    });
  });
  state.placesFuse = new Fuse(places, {
    keys: [
      { name: 'name_en', weight: 1.0 },
      { name: 'name_fa', weight: 1.0, getFn: p => normalize(p.name_fa) },
      { name: 'name_da', weight: 1.0, getFn: p => normalize(p.name_da) },
    ],
    threshold: 0.3,
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: 2,
    isCaseSensitive: false,
    shouldSort: true,
  });
}

function runPlaceSearch(q) {
  if (!state.placesFuse) return [];
  return state.placesFuse.search(normalize(q));
}

/* ============================================================ *
 *  Small DOM helpers                                           *
 * ============================================================ */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'for') el.htmlFor = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };

// Escape for safe innerHTML insertion (we mostly use textContent, but <mark> needs html).
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================================================ *
 *  Display helpers (language-aware names, breadcrumbs, etc.)   *
 * ============================================================ */
function itemName(item) {
  const lang = getLang();
  return item['name_' + lang] || item.name_en || item.name_fa || item.name_da || t('untitled');
}
function localName(obj, fallback) {
  if (!obj) return fallback || '';
  const lang = getLang();
  return obj['name_' + lang] || obj.name_en || obj.name_fa || obj.name_da || fallback || '';
}
function cellLabel(cell) {
  if (!cell) return '';
  const lang = getLang();
  return cell['label_' + lang] || cell.label_en || cell.label_fa || cell.label_da || '';
}

// Resolve an item's primary (or first) location into {room, unit, cell}.
function primaryLocation(item) {
  if (!item.locations || !item.locations.length) return null;
  const loc = item.locations.find(l => l.is_primary) || item.locations[0];
  const unit = state.unitById.get(loc.unit_id) || null;
  const room = unit ? state.roomById.get(unit.room_id) || null : null;
  const cell = loc.cell_id != null ? state.cellById.get(loc.cell_id) || null : null;
  return { loc, room, unit, cell };
}

// Build a breadcrumb element Room › Unit › Cell. Each crumb is tappable.
function breadcrumb(item) {
  const pl = primaryLocation(item);
  if (!pl || (!pl.room && !pl.unit)) {
    return h('div', { class: 'breadcrumb breadcrumb--empty' }, t('no_location'));
  }
  const crumbs = [];
  if (pl.room) {
    crumbs.push(h('a', {
      class: 'breadcrumb__crumb', href: '#/browse/room/' + pl.room.id,
    }, localName(pl.room)));
  }
  if (pl.unit) {
    crumbs.push(h('a', {
      class: 'breadcrumb__crumb', href: '#/browse/unit/' + pl.unit.id,
    }, localName(pl.unit)));
  }
  if (pl.cell) {
    const lbl = cellLabel(pl.cell) || t('cell');
    crumbs.push(h('span', { class: 'breadcrumb__crumb breadcrumb__crumb--cell' }, lbl));
  }
  const out = h('nav', { class: 'breadcrumb', 'aria-label': t('location') });
  crumbs.forEach((c, i) => {
    if (i) out.appendChild(h('span', { class: 'breadcrumb__sep', 'aria-hidden': 'true' }));
    out.appendChild(c);
  });
  return out;
}

// Mini location map for a unit. If the unit has a grid, render schematic cells with the
// item's cell marked data-here. Degrade to a plain location chip when there is no grid.
function miniMap(item, opts = {}) {
  const pl = primaryLocation(item);
  if (!pl || !pl.unit) {
    return h('div', { class: 'minimap minimap--chip' }, t('no_location'));
  }
  const unit = pl.unit;
  if (unitLayout(unit) === 'closet') {
    // Closet -> to-scale miniature with the item's zone marked.
    const m = closetSchematic(closetLayoutOf(unit), {
      mode: 'mini', hereCellId: pl.cell ? pl.cell.id : null,
    });
    m.setAttribute('role', 'img');
    m.setAttribute('aria-label', localName(unit));
    return m;
  }
  if (!unit.grid_rows || !unit.grid_cols) {
    // No grid -> plain location chip.
    return h('div', { class: 'minimap minimap--chip', title: localName(unit) }, localName(unit));
  }
  const grid = h('div', {
    class: 'minimap',
    role: 'img',
    'aria-label': localName(unit),
    style: `--rows:${unit.grid_rows};--cols:${unit.grid_cols}`,
  });
  const hereCellId = pl.cell ? pl.cell.id : null;
  const cellsOfUnit = state.cells.filter(c => c.unit_id === unit.id);
  const byRC = new Map(cellsOfUnit.map(c => [c.row + ':' + c.col, c]));
  for (let r = 0; r < unit.grid_rows; r++) {
    for (let c = 0; c < unit.grid_cols; c++) {
      const cell = byRC.get(r + ':' + c);
      const isHere = cell && hereCellId != null && cell.id === hereCellId;
      grid.appendChild(h('span', {
        class: 'minimap__cell' + (isHere ? ' minimap__cell--here' : ''),
        ...(isHere ? { 'data-here': 'true' } : {}),
      }));
    }
  }
  return grid;
}

/* ============================================================ *
 *  Closet layout — shared to-scale renderer (Phase D)          *
 * ============================================================ */

// Effective layout mode of a unit ('grid' | 'closet' | 'none').
function unitLayout(u) {
  if (!u) return 'none';
  if (u.layout) return u.layout;
  return (u.grid_rows && u.grid_cols) ? 'grid' : 'none';
}

// Build a renderable closet layout object from bootstrap state: each section
// carries its zones (= the cells of that column, top -> bottom).
function closetLayoutOf(unit) {
  const secs = (unit.sections || []).slice().sort((a, b) => a.col - b.col);
  const cells = state.cells.filter(c => c.unit_id === unit.id);
  return {
    height_cm: unit.height_cm != null ? unit.height_cm : 236,
    sections: secs.map(s => ({
      width_cm: s.width_cm, corner: !!s.corner,
      zones: cells.filter(c => c.col === s.col).sort((a, b) => a.row - b.row)
        .map(c => ({ kind: c.kind, height_cm: c.height_cm, cell: c })),
    })),
  };
}

// Localized label of a zone: live zones carry their cell; template/composer
// zones carry raw label_en/fa/da fields.
function zoneLabel(z) {
  if (z.cell) return cellLabel(z.cell);
  const lang = getLang();
  return z['label_' + lang] || z.label_en || z.label_fa || z.label_da || '';
}

// Localized number (Persian digits under fa).
function fmtNum(n) {
  if (n == null || isNaN(n)) return '';
  const v = Math.round(n * 10) / 10;
  return getLang() === 'fa' ? v.toLocaleString('fa-IR') : String(v);
}

// Per-section effective zone heights (cm): fixed zones keep height_cm, flex
// (null) zones share the leftover equally; a fixed-only section shorter than
// the closet gets a phantom "rest" spacer so everything stays to scale.
function closetEffHeights(section, totalH) {
  const zs = section.zones;
  const fixed = zs.reduce((s, z) => s + (z.height_cm != null ? Number(z.height_cm) : 0), 0);
  const flexN = zs.filter(z => z.height_cm == null).length;
  const flexH = flexN ? Math.max(8, (totalH - fixed) / flexN) : 0;
  const eff = zs.map(z => (z.height_cm != null ? Number(z.height_cm) : flexH));
  let total = eff.reduce((s, x) => s + x, 0);
  let rest = 0;
  if (!flexN && total < totalH - 0.5) { rest = totalH - total; total = totalH; }
  return { eff, rest };
}

// Hanging-rail line art: rail + three wire hangers (stroke set in CSS).
function closetRailSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 120 18');
  svg.setAttribute('class', 'closet__rail');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M4 3h112' +
    'M36 3v3l-6 9h12l-6-9M60 3v3l-6 9h12l-6-9M84 3v3l-6 9h12l-6-9');
  svg.appendChild(p);
  return svg;
}

// Small corner glyph for L-shaped (corner) sections.
function closetCornerMark() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('class', 'closet__cornermark');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M1.5 9V1.5H9');
  svg.appendChild(p);
  return svg;
}

// Shared to-scale closet renderer — an architectural drawing of the unit.
// Sections sit side by side (widths proportional to width_cm); zones stack
// inside each section (heights proportional to height_cm; flex zones share
// the remainder). Kind-specific line art: drawer fronts with a handle,
// shelf boards, hanging rails with wire hangers, recessed open bays,
// crosshatched baskets. Corner sections get an angled cut + glyph.
//
// modes:
//   'browse'  — trackable zones are buttons -> opts.onOpen(cell, btn, root);
//               count badges; cm ruler + width labels (blueprint chrome).
//   'picker'  — trackable zones select via opts.onPick(cell); open zones inert.
//   'preview' — inert drawing with full blueprint chrome (composer).
//   'mini'    — tiny miniature for tiles/mini-maps (no chrome, no labels).
// opts: { mode, unit, highlightCellId, selectedCellId, hereCellId,
//         filledCellIds:Set<cellId>, onOpen, onPick }
function closetSchematic(layout, opts = {}) {
  const mode = opts.mode || 'browse';
  const mini = mode === 'mini';
  const chrome = mode === 'browse' || mode === 'preview'; // ruler + width labels
  const totalH = Math.max(Number(layout.height_cm) || 236, 1);
  const totalW = Math.max(
    layout.sections.reduce((s, x) => s + (Number(x.width_cm) || 0), 0), 1);

  const root = h('div', { class: 'closet closet--' + mode });
  const fig = h('div', { class: 'closet__fig' });
  root.appendChild(fig);
  const draw = h('div', { class: 'closet__draw' });
  fig.appendChild(draw);

  // Cap the drawing height (keeps narrow/tall closets from towering): the
  // aspect-ratio keeps it to scale, the max width caps the derived height.
  if (!mini) {
    const maxH = mode === 'picker' ? 300 : 440;
    fig.style.maxInlineSize =
      (Math.round(maxH * totalW / totalH) + (chrome ? 34 : 0)) + 'px';
  }

  // cm ruler (blueprint chrome only).
  if (chrome) {
    const scale = h('div', { class: 'closet__scale', 'aria-hidden': 'true' });
    const marks = [0];
    for (let m = 50; m < totalH - 14; m += 50) marks.push(m);
    marks.push(Math.round(totalH));
    marks.forEach(m => {
      scale.appendChild(h('span', {
        class: 'closet__tick',
        style: `inset-block-start:${(m / totalH) * 100}%`,
      }, fmtNum(m)));
    });
    draw.appendChild(scale);
  }

  const sectionsEl = h('div', {
    class: 'closet__sections',
    style: `aspect-ratio:${totalW}/${totalH}`,
  });
  draw.appendChild(sectionsEl);

  function zoneEl(z, effH) {
    const cell = z.cell || null;
    const trackable = z.kind !== 'open';
    const interactive = (mode === 'browse' || mode === 'picker') && trackable && cell;
    const isHit = cell && opts.highlightCellId != null && cell.id === opts.highlightCellId;
    const isSel = cell && opts.selectedCellId != null && cell.id === opts.selectedCellId;
    const isHere = cell && opts.hereCellId != null && cell.id === opts.hereCellId;
    const isFilled = cell && opts.filledCellIds && opts.filledCellIds.has(cell.id);
    const count = (mode === 'browse' && opts.unit && cell)
      ? itemsInCell(opts.unit.id, cell.id).length : 0;
    let cls = 'closet__zone closet__zone--' + z.kind;
    if (isHit) cls += ' is-hit';
    if (isSel) cls += ' is-selected';
    if (isHere) cls += ' is-here';
    if (isFilled) cls += ' is-filled';
    if (count) cls += ' has-items';
    const attrs = { class: cls, style: `flex-grow:${Math.max(effH, 1)}` };
    let el;
    if (interactive) {
      el = h('button', {
        ...attrs, type: 'button',
        'aria-label': (zoneLabel(z) || t('kind_' + z.kind)) +
          (mode === 'browse' ? ' · ' + tCount('items', count) : ''),
        ...(mode === 'picker' ? { 'aria-pressed': isSel ? 'true' : 'false' } : {}),
      });
      if (mode === 'browse' && opts.onOpen) {
        el.addEventListener('click', () => opts.onOpen(cell, el, root));
      }
      if (mode === 'picker' && opts.onPick) {
        el.addEventListener('click', () => opts.onPick(cell));
      }
    } else {
      el = h('div', attrs);
    }
    if (!mini) {
      if (z.kind === 'hanging') el.appendChild(closetRailSvg());
      if (z.kind === 'drawer') {
        el.appendChild(h('span', { class: 'closet__handle', 'aria-hidden': 'true' }));
      }
      const lbl = zoneLabel(z);
      if (lbl) el.appendChild(h('span', { class: 'closet__zlabel', dir: 'auto' }, lbl));
      if (count) el.appendChild(h('span', { class: 'schematic__badge' }, String(count)));
    }
    return el;
  }

  layout.sections.forEach(sec => {
    const { eff, rest } = closetEffHeights(sec, totalH);
    const col = h('div', {
      class: 'closet__col' + (sec.corner ? ' closet__col--corner' : ''),
      style: `flex-grow:${Math.max(Number(sec.width_cm) || 1, 1)}`,
    });
    sec.zones.forEach((z, zi) => col.appendChild(zoneEl(z, eff[zi])));
    if (rest > 0) {
      col.appendChild(h('div', {
        class: 'closet__rest', style: `flex-grow:${rest}`, 'aria-hidden': 'true',
      }));
    }
    if (sec.corner && !mini) col.appendChild(closetCornerMark());
    sectionsEl.appendChild(col);
  });

  // Width labels under the sections (blueprint chrome only).
  if (chrome) {
    const widths = h('div', { class: 'closet__widths', 'aria-hidden': 'true' });
    layout.sections.forEach(sec => {
      widths.appendChild(h('span', {
        class: 'closet__wlabel',
        style: `flex-grow:${Math.max(Number(sec.width_cm) || 1, 1)}`,
      }, h('bdi', null, fmtNum(sec.width_cm) + ' ' + t('cm_short'))));
    });
    fig.appendChild(widths);
  }
  return root;
}

// status chip with icon + text (brand is green, so status never relies on green alone).
function statusChip(status) {
  const map = {
    in_stock: { key: 'in_stock', icon: ICONS.check, cls: 'chip--instock' },
    borrowed: { key: 'borrowed', icon: ICONS.hand, cls: 'chip--borrowed' },
    lost: { key: 'lost', icon: ICONS.alert, cls: 'chip--lost' },
    archived: { key: 'archived', icon: ICONS.archive, cls: 'chip--archived' },
  };
  const m = map[status] || map.in_stock;
  return h('span', { class: 'chip ' + m.cls },
    iconEl(m.icon),
    h('span', null, t(m.key)));
}

/* ============================================================ *
 *  Inline SVG icons (no external requests)                     *
 * ============================================================ */
const ICONS = {
  search: 'M11 4a7 7 0 1 0 4.2 12.6l4.1 4.1 1.4-1.4-4.1-4.1A7 7 0 0 0 11 4Zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z',
  camera: 'M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9Zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z',
  back: 'M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z',
  check: 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z',
  hand: 'M13 1a2 2 0 0 0-2 2v6h-1V4a2 2 0 0 0-4 0v9.3l-2.3-2.3a1.7 1.7 0 0 0-2.4 2.4l4.7 4.9A6 6 0 0 0 10.4 21H15a5 5 0 0 0 5-5V6a2 2 0 0 0-4 0v3h-1V3a2 2 0 0 0-2-2Z',
  alert: 'M12 2 1 21h22zM11 10h2v5h-2zm0 7h2v2h-2z',
  archive: 'M3 3h18v4H3zm1 6h16v12H4zm5 3v2h6v-2z',
  more: 'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  trash: 'M9 3v1H4v2h16V4h-5V3zM6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13z',
  edit: 'm14.06 6.19 3.75 3.75L8.92 18.83l-3.92.92.92-3.92zM20.7 5.6l-2.3-2.3a1 1 0 0 0-1.4 0l-1.7 1.7 3.7 3.7 1.7-1.7a1 1 0 0 0 0-1.4z',
  box: 'M21 8 12 3 3 8v8l9 5 9-5zM12 5.3 17.5 8 12 11 6.5 8zM5 9.7l6 3.3v6.2l-6-3.3zm14 0v6.2l-6 3.3v-6.2z',
  room: 'M10 20v-6h4v6h5V9l-7-5-7 5v11z',
  plus: 'M11 5v6H5v2h6v6h2v-6h6v-2h-6V5z',
  nfc: 'M20 2H4a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Zm0 18H4V4h16v16ZM18 6h-5a2 2 0 0 0-2 2v2.28c-.6.35-1 .98-1 1.72a2 2 0 1 0 4 0c0-.74-.4-1.37-1-1.72V8h3v8H8V8h2V6H6v12h12V6Z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  home: 'M12 3 2 12h3v8h6v-6h2v6h6v-8h3z',
};
// All ICONS above are filled-shape paths (fill:currentColor via .icon).
function iconEl(path, cls) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.appendChild(p);
  return svg;
}

/* ============================================================ *
 *  Toasts (outcome-first, with Undo)                          *
 * ============================================================ */
function announce(msg) {
  const live = $('#live');
  // clear-then-set on a later tick so screen readers re-announce even identical text.
  // setTimeout (not requestAnimationFrame) so it still fires when the tab is backgrounded.
  if (live) { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 60); }
}

function toast(message, { undo, duration = 6000, kind = '' } = {}) {
  // Announcements go through announce()/#live ONLY (the #toasts host has no aria-live and
  // the toast element has no role=status) so screen readers never read a toast twice.
  const host = $('#toasts');
  const el = h('div', { class: 'toast' + (kind ? ' toast--' + kind : '') });
  el.appendChild(h('span', { class: 'toast__msg' }, message));
  let timer = null;
  const dismiss = () => {
    if (!el.parentNode) return;
    el.classList.add('toast--out');
    setTimeout(() => { if (el.parentNode) host.removeChild(el); }, 200);
    if (timer) clearTimeout(timer);
  };
  if (undo) {
    el.appendChild(h('button', {
      class: 'toast__undo', type: 'button',
      onclick: () => { dismiss(); undo(); },
    }, t('undo')));
  }
  host.appendChild(el);
  announce(message);
  timer = setTimeout(dismiss, duration);
  return dismiss;
}

/* ============================================================ *
 *  Confirm dialog                                             *
 * ============================================================ */
function confirmDialog(message, { confirmLabel, danger } = {}) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const overlay = h('div', { class: 'modal-overlay' });
    const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('p', { class: 'modal__body' }, message),
      h('div', { class: 'modal__actions' },
        h('button', { class: 'btn btn--ghost', type: 'button',
          onclick: () => done(false) }, t('cancel')),
        h('button', {
          class: 'btn ' + (danger ? 'btn--danger' : 'btn--primary'), type: 'button',
          onclick: () => done(true),
        }, confirmLabel || t('confirm')),
      ),
    );
    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    function onKey(e) { if (e.key === 'Escape') done(false); }
    function done(v) {
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) root.removeChild(overlay);
      resolve(v);
    }
    document.addEventListener('keydown', onKey);
    root.appendChild(overlay);
    dialog.querySelector('.btn--primary, .btn--danger').focus();
  });
}

/* ============================================================ *
 *  Inline form errors (field-level, ARIA-wired)               *
 * ============================================================ */
// setFieldError(input, msg): red hairline on the input, terracotta error line
// under it, aria-invalid + aria-describedby. clearFieldError undoes it all.
// Every form (add/edit, checkout, NFC assign, grid editor) uses this pattern.
let fieldErrSeq = 0;
function setFieldError(input, message) {
  clearFieldError(input);
  const field = input.closest('.field') || input.parentElement;
  if (!field) return;
  const id = 'field-err-' + (++fieldErrSeq);
  field.classList.add('field--invalid');
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', id);
  field.appendChild(h('p', { class: 'field__error', id, role: 'alert' }, message));
}
function clearFieldError(input) {
  const field = input.closest('.field') || input.parentElement;
  if (!field) return;
  const err = field.querySelector('.field__error');
  if (err) err.remove();
  field.classList.remove('field--invalid');
  input.removeAttribute('aria-invalid');
  input.removeAttribute('aria-describedby');
}
// Bring the offending field into view and focus it (reduced-motion aware).
function focusFieldError(input) {
  try {
    input.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  } catch (_) {}
  input.focus({ preventScroll: true });
}

/* ============================================================ *
 *  Warm line-art illustrations (empty states, placeholders)   *
 * ============================================================ */
// Hand-drawn-feel stroke SVGs, 1.5px, ink + sage (+ a rare terracotta spark).
// Colors come from CSS classes (var() is invalid in SVG presentation attrs).
const ILLOS = {
  // paper sheet + magnifier — search / no results
  search: `<svg viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg">
    <g class="illo-ink"><rect x="34" y="12" width="52" height="66" rx="5"/>
      <path d="M44 27h28M44 37h32M44 47h20M44 57h26"/></g>
    <g class="illo-sage"><circle cx="93" cy="62" r="14"/><path d="M104 73l13 13"/></g>
    <g class="illo-terra"><path d="M24 25v8M20 29h8"/><circle cx="112" cy="24" r="1.8"/></g>
  </svg>`,
  // open carton — items / not found
  box: `<svg viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg">
    <g class="illo-ink"><path d="M38 46l32-14 32 14-32 14z"/>
      <path d="M38 46v24l32 14 32-14V46"/><path d="M70 60v24"/>
      <path d="M38 46l-13-8 32-14 13 8"/><path d="M102 46l13-8-32-14-13 8"/></g>
    <g class="illo-sage"><path d="M70 22V10M59 16l-6-8M81 16l6-8"/></g>
  </svg>`,
  // doorway + little plant — rooms
  room: `<svg viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg">
    <g class="illo-ink"><path d="M48 86V32a22 22 0 0 1 44 0v54"/>
      <path d="M34 86h72"/><circle cx="84" cy="58" r="2.2"/></g>
    <g class="illo-sage"><path d="M112 86V74"/>
      <path d="M112 76c-6-2-9-8-9-13 6 0 11 5 9 13z"/>
      <path d="M112 78c6-2 9-8 9-13-6 0-11 5-9 13z"/></g>
  </svg>`,
  // box with exchange arrows — borrowed
  hand: `<svg viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg">
    <g class="illo-ink"><rect x="52" y="37" width="36" height="28" rx="4"/><path d="M52 47h36"/></g>
    <g class="illo-sage"><path d="M40 28a40 28 0 0 1 61-3"/><path d="M101 15v10h-10"/>
      <path d="M100 74a40 28 0 0 1-61 3"/><path d="M39 87V77h10"/></g>
  </svg>`,
  // tag card + radio waves — NFC
  nfc: `<svg viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg">
    <g class="illo-ink"><rect x="38" y="24" width="46" height="54" rx="9"/><circle cx="61" cy="51" r="5"/></g>
    <g class="illo-sage"><path d="M96 38a25 25 0 0 1 0 26"/><path d="M105 30a37 37 0 0 1 0 42"/></g>
    <g class="illo-terra"><circle cx="30" cy="18" r="1.8"/></g>
  </svg>`,
  // little house — first run
  house: `<svg viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg">
    <g class="illo-ink"><path d="M32 54 70 24l38 30"/><path d="M42 48v38h56V48"/>
      <path d="M62 86V66h16v20"/></g>
    <g class="illo-terra"><circle cx="70" cy="46" r="3"/></g>
    <g class="illo-sage"><path d="M18 86h14M108 86h14"/></g>
  </svg>`,
  // pigeon-hole with one sage compartment — units / grids
  grid: `<svg viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg">
    <g class="illo-ink"><rect x="38" y="22" width="64" height="58" rx="4"/>
      <path d="M38 41h64M38 61h64M59 22v58M81 22v58"/></g>
    <g class="illo-sage"><rect x="63" y="46" width="14" height="11" rx="2"/></g>
    <g class="illo-terra"><path d="M112 18v7M108.5 21.5h7"/></g>
  </svg>`,
  // wardrobe: rail + hanger on the left, drawers on the right — closets
  closet: `<svg viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg">
    <g class="illo-ink"><rect x="40" y="12" width="60" height="74" rx="3"/>
      <path d="M70 12v74"/><path d="M70 38h30M70 54h30M70 70h30"/>
      <path d="M82 46h6M82 62h6M82 78h6"/>
      <path d="M46 86v5M94 86v5"/><path d="M40 70h30"/></g>
    <g class="illo-sage"><path d="M46 26h18"/><path d="M55 26v3l-5 7h10l-5-7"/></g>
    <g class="illo-terra"><path d="M114 22v8M110 26h8"/><circle cx="28" cy="18" r="1.8"/></g>
  </svg>`,
};
function illoEl(name, cls) {
  return h('div', {
    class: cls || 'empty__illo', 'aria-hidden': 'true',
    html: ILLOS[name] || ILLOS.box,
  });
}

/* ============================================================ *
 *  App shell (header + nav)                                   *
 * ============================================================ */
let viewRoot = null; // the <main> the screens render into

function renderShell() {
  const app = $('#app');
  clear(app);

  const header = h('header', { class: 'appbar' },
    h('button', {
      class: 'iconbtn appbar__menu', type: 'button',
      'aria-label': t('menu'), onclick: openSettings,
    }, iconEl(ICONS.more)),
    h('a', { class: 'appbar__brand', href: '#/' },
      iconEl(ICONS.box, 'appbar__logo'),
      h('span', { class: 'appbar__title' }, t('app_name')),
    ),
    h('div', { class: 'appbar__spacer' }),
  );

  viewRoot = h('main', { id: 'view', class: 'view', tabindex: '-1' });

  const nav = h('nav', { class: 'tabbar', 'aria-label': t('menu') },
    tabLink('#/', ICONS.home, 'nav_start'),
    tabLink('#/search', ICONS.search, 'nav_home'),
    tabLink('#/browse', ICONS.grid, 'nav_browse'),
    tabLink('#/borrowed', ICONS.hand, 'nav_borrowed'),
    tabLink('#/objects', ICONS.box, 'nav_objects'),
  );

  // Persistent camera FAB (quick add).
  const fab = h('button', {
    class: 'fab', type: 'button', 'aria-label': t('add_item'),
    onclick: () => { location.hash = '#/add'; },
  }, iconEl(ICONS.camera, 'fab__icon'));

  app.appendChild(header);
  app.appendChild(viewRoot);
  app.appendChild(fab);
  app.appendChild(nav);
}

function tabLink(hash, icon, key) {
  return h('a', {
    class: 'tabbar__link', href: hash, 'data-tab': hash,
  }, iconEl(icon, 'tabbar__icon'), h('span', { class: 'tabbar__label' }, t(key)));
}

function setActiveTab(hash) {
  document.querySelectorAll('.tabbar__link').forEach(a => {
    const base = '#' + (location.hash.slice(1).split('/')[1] ? '/' + location.hash.slice(1).split('/')[1] : '/');
    a.classList.toggle('is-active', a.dataset.tab === base || (a.dataset.tab === '#/' && base === '#/'));
  });
}

/* ============================================================ *
 *  Settings / overflow menu                                   *
 * ============================================================ */
const THEME_KEY = 'theme';
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
  else root.removeAttribute('data-theme'); // auto -> follow prefers-color-scheme
}
function currentTheme() { return localStorage.getItem(THEME_KEY) || 'auto'; }

function openSettings() {
  const root = $('#modal-root');
  const overlay = h('div', { class: 'modal-overlay modal-overlay--sheet' });
  const close = () => { document.removeEventListener('keydown', onKey); if (overlay.parentNode) root.removeChild(overlay); };
  function onKey(e) { if (e.key === 'Escape') close(); }

  const themeRow = h('div', { class: 'settings__seg', role: 'group', 'aria-label': t('theme') });
  [['auto', 'theme_auto'], ['light', 'theme_light'], ['dark', 'theme_dark']]
    .forEach(([val, key]) => {
      const btn = h('button', {
        class: 'seg__btn' + (currentTheme() === val ? ' is-active' : ''),
        type: 'button',
        onclick: () => {
          localStorage.setItem(THEME_KEY, val); applyTheme(val);
          themeRow.querySelectorAll('.seg__btn').forEach(b => b.classList.remove('is-active'));
          btn.classList.add('is-active');
        },
      }, t(key));
      themeRow.appendChild(btn);
    });

  const langRow = h('div', { class: 'settings__seg', role: 'group', 'aria-label': t('language') });
  LANGS.forEach(lang => {
    const btn = h('button', {
      class: 'seg__btn' + (getLang() === lang ? ' is-active' : ''),
      type: 'button',
      onclick: () => { setLang(lang); close(); renderShell(); route(); },
    }, LANG_LABELS[lang]);
    langRow.appendChild(btn);
  });

  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('settings') },
    h('div', { class: 'sheet__handle', 'aria-hidden': 'true' }),
    h('h2', { class: 'sheet__title' }, t('settings')),
    h('div', { class: 'settings__group' },
      h('p', { class: 'settings__label' }, t('theme')), themeRow),
    h('div', { class: 'settings__group' },
      h('p', { class: 'settings__label' }, t('language')), langRow),
    h('div', { class: 'settings__group' },
      h('button', {
        class: 'btn btn--ghost btn--block', type: 'button',
        onclick: () => { close(); location.hash = '#/nfc'; },
      }, iconEl(ICONS.nfc), h('span', null, t('nfc_tags')))),
    h('div', { class: 'settings__group' },
      h('button', {
        class: 'btn btn--ghost btn--block', type: 'button',
        onclick: async () => {
          if (await confirmDialog(t('reset_confirm'), { confirmLabel: t('reset_demo') })) {
            close(); await adminReset();
          }
        },
      }, t('reset_demo')),
      h('button', {
        class: 'btn btn--danger-ghost btn--block', type: 'button',
        onclick: async () => {
          if (await confirmDialog(t('clear_confirm'), { confirmLabel: t('clear_all'), danger: true })) {
            close(); await adminClear();
          }
        },
      }, t('clear_all')),
    ),
    h('button', { class: 'btn btn--ghost btn--block sheet__close', type: 'button', onclick: close }, t('close')),
  );
  overlay.appendChild(sheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  root.appendChild(overlay);
}

async function adminReset() {
  try {
    await apiSend('POST', 'admin/reset');
    await loadBootstrap();
    toast(t('reset_done'));
    route();
  } catch (e) { toast(t('toast_error'), { kind: 'error' }); }
}
async function adminClear() {
  try {
    await apiSend('POST', 'admin/clear');
    await loadBootstrap();
    toast(t('cleared_done'));
    route();
  } catch (e) { toast(t('toast_error'), { kind: 'error' }); }
}

/* ============================================================ *
 *  Skeleton loaders                                           *
 * ============================================================ */
function skeletonCards(n = 6) {
  const wrap = h('div', { class: 'cards' });
  for (let i = 0; i < n; i++) {
    wrap.appendChild(h('div', { class: 'card card--skeleton', 'aria-hidden': 'true' },
      h('div', { class: 'card__thumb skel' }),
      h('div', { class: 'card__body' },
        h('div', { class: 'skel skel--line skel--w70' }),
        h('div', { class: 'skel skel--line skel--w50' })),
    ));
  }
  return wrap;
}

/* ============================================================ *
 *  Result / item card                                         *
 * ============================================================ */
// Highlight matched ranges (from Fuse includeMatches against the field we searched).
// We ONLY apply <mark> when a match's value is exactly the displayed (current-language)
// name — so offsets always line up with the visible string. Any other match (e.g. a hit
// on the normalized name_fa getFn, the brand, or the search blob) renders the displayed
// name plain, never substituting another language's text.
function highlightName(item, matches) {
  const displayed = itemName(item);
  if (!matches || !matches.length) return esc(displayed);

  const m = matches.find(x => x.value === displayed && x.indices && x.indices.length);
  if (!m) return esc(displayed);

  const v = m.value;
  let out = '';
  let last = 0;
  // indices are inclusive [start,end]
  const sorted = [...m.indices].sort((a, b) => a[0] - b[0]);
  for (const [s, e] of sorted) {
    if (s > last) out += esc(v.slice(last, s));
    out += '<mark>' + esc(v.slice(s, e + 1)) + '</mark>';
    last = e + 1;
  }
  out += esc(v.slice(last));
  return out;
}

function thumbEl(item) {
  if (item.thumb_url) {
    return h('img', {
      class: 'card__thumb', loading: 'lazy', decoding: 'async',
      alt: '', src: new URL(item.thumb_url, document.baseURI).href,
    });
  }
  return h('div', { class: 'card__thumb card__thumb--ph', 'aria-hidden': 'true' }, iconEl(ICONS.box));
}

// Photography-first card: full-bleed photo on top, name + breadcrumb below.
// Renders in a 2-col grid on mobile (auto-fill on wider screens).
function itemCard(item, matches) {
  const card = h('a', { class: 'card', href: '#/item/' + item.id });
  card.appendChild(thumbEl(item));

  const body = h('div', { class: 'card__body' });
  const nameEl = h('div', { class: 'card__name', dir: 'auto' });
  nameEl.innerHTML = highlightName(item, matches);
  // Wrap embedded LTR brand in <bdi> so it doesn't reorder RTL text.
  if (item.brand) {
    nameEl.appendChild(document.createTextNode(' '));
    const bdi = document.createElement('bdi');
    bdi.className = 'card__brand';
    bdi.textContent = item.brand;
    nameEl.appendChild(bdi);
  }
  body.appendChild(nameEl);
  body.appendChild(breadcrumb(item));
  if (item.status && item.status !== 'in_stock') body.appendChild(statusChip(item.status));
  card.appendChild(body);
  return card;
}

/* ============================================================ *
 *  SCREEN 1 — Home / Search                                   *
 * ============================================================ */
let searchDebounce = null;
let lastQuery = '';
// Set by quickScan when a scanned barcode matched no item: while the search box
// still holds that code, the results area offers "add new item with this barcode".
let scanOffer = null;

function screenHome(mode) {
  const isSearch = mode === 'search';
  const wrap = h('div', { class: 'screen screen--home' + (isSearch ? ' screen--search' : '') });

  // The dedicated Search tab gets a page title; the Home landing keeps the masthead.
  if (isSearch) wrap.appendChild(pageHead(t('search')));

  const hero = h('section', { class: 'hero' });
  // Serif hero line — the magazine masthead. (With 0 items the first-run
  // hero below carries the tagline instead, so skip it here. The Search
  // screen has its own page title, so no masthead there either.)
  if (!isSearch && state.items.length) {
    hero.appendChild(h('h1', { class: 'hero__title' }, t('tagline')));
  }
  const combo = h('div', {
    class: 'searchbox', role: 'combobox', 'aria-expanded': 'false',
    'aria-haspopup': 'listbox', 'aria-owns': 'search-results',
  });
  const input = h('input', {
    class: 'searchbox__input', type: 'search', id: 'search-input',
    'aria-label': t('search'), 'aria-controls': 'search-results',
    'aria-autocomplete': 'list', autocomplete: 'off', enterkeyhint: 'search',
    placeholder: t('search_placeholder'), dir: 'auto',
  });
  const scanBtn = h('button', {
    class: 'searchbox__scan iconbtn', type: 'button', 'aria-label': t('scan_barcode'),
    onclick: () => quickScan(input),
  }, iconEl(ICONS.camera));
  combo.appendChild(iconEl(ICONS.search, 'searchbox__icon'));
  combo.appendChild(input);
  combo.appendChild(scanBtn);
  hero.appendChild(combo);
  wrap.appendChild(hero);

  // Quick actions — large tap targets for the most common flows (Home only).
  // A flex/grid row of logical-order children, so RTL flips order automatically.
  if (!isSearch) wrap.appendChild(quickActions(input));

  const results = h('div', { id: 'search-results', class: 'results', role: 'listbox',
    'aria-label': t('search') });
  wrap.appendChild(results);

  function renderResults(q) {
    // A debounced search may fire after the user navigated away; never touch detached nodes.
    if (!results.isConnected) return;
    clear(results);
    const nq = q.trim();
    // Scanned barcode with no exact owner: offer creating an item with it, for as
    // long as the query still is that code (typing anything else drops the offer).
    if (scanOffer && nq === scanOffer) results.appendChild(scanOfferBanner(scanOffer));
    else scanOffer = null;
    if (nq.length < 2) {
      combo.setAttribute('aria-expanded', 'false');
      renderRecent(results);
      return;
    }
    combo.setAttribute('aria-expanded', 'true');
    const hits = runSearch(nq);
    const placeHits = runPlaceSearch(nq).slice(0, 4);
    if (!hits.length && !placeHits.length) {
      results.appendChild(emptyState({
        illo: 'search', title: t('no_results_title'), sub: t('no_results_sub'),
        actionLabel: t('add_item'), action: () => { location.hash = '#/add'; },
      }));
      announce(t('results_none'));
      return;
    }
    // Matching places (rooms / units / cells) as a compact group above items.
    if (placeHits.length) {
      results.appendChild(h('h2', { class: 'section-title' }, t('places')));
      const list = h('div', { class: 'picklist' });
      placeHits.forEach(hit => {
        const row = placeRow(hit.item);
        row.setAttribute('role', 'option');
        list.appendChild(row);
      });
      results.appendChild(list);
    }
    if (hits.length) {
      if (placeHits.length) {
        results.appendChild(h('h2', { class: 'section-title' }, tCount('items', hits.length)));
      }
      const cards = h('div', { class: 'cards' });
      hits.forEach(hit => {
        const card = itemCard(hit.item, hit.matches);
        card.setAttribute('role', 'option');
        cards.appendChild(card);
      });
      results.appendChild(cards);
    }
    announce(tCount('results', hits.length + placeHits.length));
  }

  input.addEventListener('input', () => {
    const q = input.value;
    lastQuery = q;
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => renderResults(q), 170);
  });

  // restore last query if any
  input.value = lastQuery;

  // Render initial content (first-run hero / recent items / restored search) AFTER
  // mount. renderResults() bails when `results` isn't connected (the guard that stops
  // stale debounced searches from touching detached nodes), and at build time `wrap`
  // is not in the DOM yet — so defer one tick so results.isConnected is true.
  setTimeout(() => { renderResults(lastQuery); if (isSearch) input.focus(); }, 0);
  return wrap;
}

function renderRecent(container) {
  const recent = [...state.items]
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, 20);
  if (!recent.length) {
    container.appendChild(firstRunHero());
    return;
  }
  container.appendChild(h('h2', { class: 'section-title' }, t('recently_added')));
  const cards = h('div', { class: 'cards' });
  recent.forEach(it => cards.appendChild(itemCard(it)));
  container.appendChild(cards);
}

// Warm first-run experience: shown on Home only when there are 0 items and no query.
function firstRunHero() {
  const root = h('div', { class: 'firstrun' });

  // Hero: warm line-art house + app name + tagline.
  root.appendChild(h('div', { class: 'firstrun__hero' },
    illoEl('house', 'firstrun__illo'),
    h('h2', { class: 'firstrun__title' }, t('app_name')),
    h('p', { class: 'firstrun__tagline' }, t('tagline')),
  ));

  // Two prominent sage-branded primary actions.
  root.appendChild(h('div', { class: 'firstrun__actions' },
    h('a', { class: 'btn btn--primary btn--lg', href: '#/add' },
      iconEl(ICONS.plus), h('span', null, t('add_first_item_cta'))),
    h('a', { class: 'btn btn--ghost btn--lg', href: '#/browse' },
      iconEl(ICONS.room), h('span', null, t('browse_shelves'))),
  ));

  // Rooms from bootstrap as tappable chips so there's real content + an obvious way in.
  const rooms = state.rooms.slice().sort((a, b) => a.sort_order - b.sort_order);
  if (rooms.length) {
    root.appendChild(h('h3', { class: 'firstrun__rooms-title' }, t('your_rooms')));
    const chips = h('div', { class: 'roomchips' });
    rooms.forEach(room => {
      chips.appendChild(h('a', { class: 'roomchip', href: '#/browse/room/' + room.id },
        iconEl(ICONS.room, 'roomchip__icon'),
        h('span', { class: 'roomchip__name' }, localName(room)),
      ));
    });
    root.appendChild(chips);
  }
  return root;
}

// Home quick actions: Scan / Borrowed (live count badge) / NFC tags / Rooms.
function quickActions(searchInput) {
  const row = h('div', { class: 'quickactions' });

  row.appendChild(h('button', {
    class: 'quickaction', type: 'button',
    onclick: () => quickScan(searchInput),
  }, iconEl(ICONS.camera, 'quickaction__icon'),
    h('span', { class: 'quickaction__label' }, t('qa_scan'))));

  const borrowedCount = state.borrows_open.length;
  const borrowed = h('a', {
    class: 'quickaction', href: '#/borrowed',
    'aria-label': t('nav_borrowed') + (borrowedCount ? ' (' + borrowedCount + ')' : ''),
  }, iconEl(ICONS.hand, 'quickaction__icon'),
    h('span', { class: 'quickaction__label' }, t('nav_borrowed')));
  if (borrowedCount) {
    borrowed.appendChild(h('span', {
      class: 'quickaction__badge', 'aria-hidden': 'true',
    }, String(borrowedCount)));
  }
  row.appendChild(borrowed);

  row.appendChild(h('a', { class: 'quickaction', href: '#/nfc' },
    iconEl(ICONS.nfc, 'quickaction__icon'),
    h('span', { class: 'quickaction__label' }, t('nfc_tags'))));

  row.appendChild(h('a', { class: 'quickaction', href: '#/browse' },
    iconEl(ICONS.room, 'quickaction__icon'),
    h('span', { class: 'quickaction__label' }, t('rooms'))));

  return row;
}

/* ============================================================ *
 *  SCREEN — Objects (every item across all storage)          *
 * ============================================================ */
// A flat, sortable, filterable view of every item — the counterpart to the
// room-by-room Browse. Built entirely from bootstrap state (no new endpoint):
// pigeon-holes, closets and plain units all pour their items into one list.
const OBJECTS_SORT_KEY = 'objects_sort';
const OBJECTS_FILTER_KEY = 'objects_filter';

function objectRoomId(item) {
  const pl = primaryLocation(item);
  return pl && pl.room ? pl.room.id : null;
}

function screenObjects(q) {
  q = q || {};
  const wrap = h('div', { class: 'screen screen--objects' });
  wrap.appendChild(pageHead(t('objects_title')));

  let sort = q.sort || localStorage.getItem(OBJECTS_SORT_KEY) || 'newest';
  let filter = q.status || localStorage.getItem(OBJECTS_FILTER_KEY) || 'all';

  // Sort <select> + status filter chips.
  const sortSel = h('select', { class: 'objbar__sort', 'aria-label': t('sort_label') },
    ...[['newest', 'sort_newest'], ['name', 'sort_name'], ['room', 'sort_room'], ['status', 'sort_status']]
      .map(([v, k]) => h('option', { value: v, ...(sort === v ? { selected: true } : {}) }, t(k))));
  sortSel.addEventListener('change', () => {
    sort = sortSel.value; localStorage.setItem(OBJECTS_SORT_KEY, sort); renderList();
  });

  const filterBar = h('div', { class: 'objbar__filters', role: 'group', 'aria-label': t('sort_status') });
  const FILTERS = [['all', 'filter_all'], ['in_stock', 'in_stock'],
    ['borrowed', 'nav_borrowed'], ['lost', 'lost'], ['archived', 'archived']];
  function renderFilters() {
    clear(filterBar);
    FILTERS.forEach(([v, k]) => {
      filterBar.appendChild(h('button', {
        class: 'objchip' + (filter === v ? ' objchip--active' : ''),
        type: 'button', 'aria-pressed': String(filter === v),
        onclick: () => {
          filter = v; localStorage.setItem(OBJECTS_FILTER_KEY, filter);
          renderFilters(); renderList();
        },
      }, t(k)));
    });
  }
  renderFilters();

  wrap.appendChild(h('div', { class: 'objbar' },
    h('label', { class: 'objbar__sortwrap' },
      h('span', { class: 'objbar__sortlabel' }, t('sort_label')), sortSel),
    filterBar,
  ));

  const listWrap = h('div', { class: 'objects-list' });
  wrap.appendChild(listWrap);

  const byNewest = (a, b) => (b.created_at || '').localeCompare(a.created_at || '');
  const byName = (a, b) => itemName(a).localeCompare(itemName(b), undefined, { sensitivity: 'base' });
  const byStatus = (a, b) => (a.status || '').localeCompare(b.status || '') || byNewest(a, b);

  function renderList() {
    clear(listWrap);
    let items = state.items.slice();
    if (filter !== 'all') items = items.filter(it => (it.status || 'in_stock') === filter);

    if (!items.length) {
      listWrap.appendChild(emptyState({
        illo: 'box', title: t('objects_empty_title'), sub: t('objects_empty_sub'),
        actionLabel: t('add_item'), actionHref: '#/add', actionIcon: ICONS.plus,
      }));
      return;
    }

    if (sort === 'room') {
      const groups = new Map();          // roomId (or '' = no location) -> items[]
      items.forEach(it => {
        const rid = objectRoomId(it);
        const key = rid == null ? '' : rid;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(it);
      });
      const order = state.rooms.slice().sort((a, b) => a.sort_order - b.sort_order).map(r => r.id);
      order.push('');                    // "no location" group goes last
      order.forEach(key => {
        const g = groups.get(key);
        if (!g || !g.length) return;
        const room = key === '' ? null : state.roomById.get(key);
        listWrap.appendChild(h('h2', { class: 'section-title' },
          room ? localName(room) : t('no_location')));
        const cards = h('div', { class: 'cards' });
        g.sort(byName).forEach(it => cards.appendChild(itemCard(it)));
        listWrap.appendChild(cards);
      });
    } else {
      items.sort(sort === 'name' ? byName : sort === 'status' ? byStatus : byNewest);
      const cards = h('div', { class: 'cards' });
      items.forEach(it => cards.appendChild(itemCard(it)));
      listWrap.appendChild(cards);
    }
    announce(tCount('items', items.length));
  }

  renderList();
  return wrap;
}

async function quickScan(input) {
  const result = await openScanner();
  if (!result) return;

  // A scanned code that IS a registered NFC tag id (or the HA tag URL that
  // companion-app tags carry) runs the NFC scan pipeline instead of the
  // product-barcode flow — QR fallback for phones without NFC. The HA URL
  // shape alone proves it's a tag, never a product barcode, so it goes to
  // the pipeline even when unregistered (the 'unknown' branch then offers
  // the assign flow). Raw ids only qualify when already registered.
  const raw = String(result.rawValue == null ? '' : result.rawValue).trim();
  const haTagId = parseHaTagUrl(raw);
  if (haTagId || (raw && state.nfc_tags.some(tg => tg.tag_id === raw))) {
    await nfcQuickScan(haTagId || raw);
    return;
  }

  const code = normalizeBarcode(result.rawValue);

  // Exact barcode resolution first (server-side, normalized, indexed).
  let hits = null;
  try {
    const res = await apiGet('items?barcode=' + encodeURIComponent(code));
    hits = (res && res.items) || [];
  } catch (_) { hits = null; /* offline -> fall back to fuzzy search below */ }

  if (hits && hits.length === 1) {
    // Exactly one item carries this barcode: go straight to it.
    upsertItem(hits[0]);
    toast(t('scan_found', { name: itemName(hits[0]) }));
    location.hash = '#/item/' + hits[0].id;
    return;
  }
  if (hits && hits.length > 1) {
    // Several items share the barcode: search view filtered to them.
    hits.forEach(upsertItem);
  } else if (hits && hits.length === 0) {
    // No item has this barcode: offer to create one with it prefilled.
    scanOffer = code;
  }
  if (input) { input.value = code; input.dispatchEvent(new Event('input')); }
}

// Inline offer shown in the results area after a scan found no exact barcode owner.
function scanOfferBanner(code) {
  return h('div', { class: 'scanoffer' },
    h('span', { class: 'scanoffer__text' }, t('scan_no_match'), ' ', h('bdi', null, code)),
    h('a', { class: 'btn btn--primary btn--sm', href: '#/add?barcode=' + encodeURIComponent(code) },
      iconEl(ICONS.plus), h('span', null, t('scan_add_new'))),
  );
}

// One compact "Places" search result: room -> its browse page, unit -> unit
// schematic, labelled cell -> unit schematic with the cell highlighted+opened.
function placeRow(p) {
  let href;
  let icon;
  let name;
  let meta = '';
  if (p.kind === 'room') {
    href = '#/browse/room/' + p.ref.id;
    icon = ICONS.room;
    name = localName(p.ref);
    meta = tCount('units', state.units.filter(u => u.room_id === p.ref.id).length);
  } else if (p.kind === 'unit') {
    href = '#/browse/unit/' + p.ref.id;
    icon = ICONS.box;
    name = localName(p.ref);
    const room = state.roomById.get(p.ref.room_id);
    if (room) meta = localName(room);
  } else {
    href = '#/browse/unit/' + p.ref.unit_id + '?cell=' + p.ref.id;
    icon = ICONS.grid;
    name = cellLabel(p.ref) || t('cell');
    const unit = state.unitById.get(p.ref.unit_id);
    const room = unit ? state.roomById.get(unit.room_id) : null;
    // Direction-neutral '·' join (same convention as the NFC target lines).
    meta = [room ? localName(room) : null, unit ? localName(unit) : null]
      .filter(Boolean).join(' · ');
  }
  return h('a', { class: 'pickrow', href },
    h('div', { class: 'pickrow__thumb pickrow__thumb--ph', 'aria-hidden': 'true' }, iconEl(icon)),
    h('div', { class: 'pickrow__body' },
      h('span', { class: 'pickrow__name', dir: 'auto' }, name),
      meta ? h('span', { class: 'pickrow__meta', dir: 'auto' }, meta) : null));
}

// Companion-app-written NFC tags carry a URL NDEF record
// https://www.home-assistant.io/tag/<uuid> — extract the uuid, else null.
function parseHaTagUrl(s) {
  const m = /^https?:\/\/(?:www\.)?home-assistant\.io\/tag\/([^?#]+)/i
    .exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
}

// Run a registered tag through the backend scan pipeline (source 'qr') and
// react in-app: smart-toggle toasts + navigation mirroring the push notification.
async function nfcQuickScan(tagId) {
  let r;
  try {
    r = await apiSend('POST', 'nfc/scan', { tag_id: tagId, source: 'qr' });
  } catch (_) {
    toast(t('toast_error'), { kind: 'error' });
    return;
  }
  reloadNfcTags(); // fire-and-forget: scan_count / last_scanned_at changed
  if (!r || !r.result) { toast(t('toast_error'), { kind: 'error' }); return; }
  if (r.result === 'checked_out' || r.result === 'checked_in') {
    toast(t(r.result === 'checked_out' ? 'nfc_checked_out' : 'nfc_checked_in'));
    await refreshItem(r.item_id);
    await reloadBorrows();
    nav('#/item/' + r.item_id + (r.borrow_id != null ? '?undo=' + r.borrow_id : ''));
  } else if (r.result === 'info') {
    toast(t('nfc_no_action', { status: t(r.status) }));
    nav('#/item/' + r.item_id);
  } else if (r.result === 'location') {
    nav('#/browse/unit/' + r.unit_id + (r.cell_id != null ? '?cell=' + r.cell_id : ''));
  } else if (r.result === 'target_missing' || r.result === 'unknown') {
    toast(t('nfc_target_missing'), { kind: 'error' });
    nav('#/nfc/assign?tag=' + encodeURIComponent(tagId));
  } else {
    toast(t('toast_error'), { kind: 'error' });
  }
}

/* ============================================================ *
 *  Empty state                                                *
 * ============================================================ */
function emptyState({ icon, illo, title, sub, actionLabel, action, actionHref, actionIcon }) {
  let actionEl = null;
  if (actionLabel) {
    const kids = [actionIcon ? iconEl(actionIcon) : null, h('span', null, actionLabel)];
    actionEl = actionHref
      ? h('a', { class: 'btn btn--primary', href: actionHref }, kids)
      : h('button', { class: 'btn btn--primary', type: 'button', onclick: action }, kids);
  }
  // Warm line-art illustration when one is named; icon badge as fallback.
  const art = illo
    ? illoEl(illo)
    : h('div', { class: 'empty__badge', 'aria-hidden': 'true' }, iconEl(icon || ICONS.box, 'empty__icon'));
  return h('div', { class: 'empty' },
    art,
    h('p', { class: 'empty__title' }, title),
    sub ? h('p', { class: 'empty__sub' }, sub) : null,
    actionEl,
  );
}

/* ============================================================ *
 *  SCREEN 2 — Browse                                          *
 * ============================================================ */
function screenBrowse() {
  const wrap = h('div', { class: 'screen' });
  wrap.appendChild(pageHead(t('browse')));
  if (!state.rooms.length) {
    wrap.appendChild(emptyState({
      illo: 'room', title: t('no_rooms'), sub: t('no_rooms_sub'),
      actionLabel: t('add_first_item_cta'), actionHref: '#/add', actionIcon: ICONS.plus,
    }));
    return wrap;
  }
  const grid = h('div', { class: 'tilegrid' });
  state.rooms.slice().sort((a, b) => a.sort_order - b.sort_order).forEach(room => {
    const unitCount = state.units.filter(u => u.room_id === room.id).length;
    grid.appendChild(h('a', { class: 'tile', href: '#/browse/room/' + room.id },
      iconEl(ICONS.room, 'tile__icon'),
      h('span', { class: 'tile__name' }, localName(room)),
      h('span', { class: 'tile__meta' }, tCount('units', unitCount)),
    ));
  });
  wrap.appendChild(grid);
  return wrap;
}

function screenBrowseRoom(roomId) {
  const room = state.roomById.get(roomId);
  const wrap = h('div', { class: 'screen' });
  if (!room) { wrap.appendChild(emptyState({ illo: 'room', title: t('no_rooms') })); return wrap; }
  wrap.appendChild(pageHead(localName(room), '#/browse'));
  const units = state.units.filter(u => u.room_id === roomId).sort((a, b) => a.sort_order - b.sort_order);
  if (!units.length) { wrap.appendChild(emptyState({ illo: 'grid', title: t('no_units') })); return wrap; }
  const grid = h('div', { class: 'tilegrid' });
  units.forEach(unit => {
    // Grid/closet units show the trackable-compartment count; plain units the item count.
    const lay = unitLayout(unit);
    const meta = (lay === 'grid' || lay === 'closet')
      ? tCount('compartments', countDoorCells(unit.id))
      : tCount('items', countItemsInUnit(unit.id));
    grid.appendChild(h('a', { class: 'tile', href: '#/browse/unit/' + unit.id },
      h('span', { class: 'tile__mini' }, unitMiniature(unit)),
      h('span', { class: 'tile__name' }, localName(unit)),
      h('span', { class: 'tile__meta' }, meta),
    ));
  });
  wrap.appendChild(grid);
  return wrap;
}

// Live miniature of a unit's schematic for its browse tile: door cells as
// paper squares (sage-filled when something is stored there), open cells
// hatched. Falls back to the box icon for grid-less units.
function unitMiniature(unit) {
  if (unitLayout(unit) === 'closet') {
    const filled = new Set();
    state.items.forEach(it => (it.locations || []).forEach(l => {
      if (l.unit_id === unit.id && l.cell_id != null) filled.add(l.cell_id);
    }));
    const m = closetSchematic(closetLayoutOf(unit), { mode: 'mini', filledCellIds: filled });
    m.setAttribute('aria-hidden', 'true');
    return m;
  }
  if (!unit.grid_rows || !unit.grid_cols) return iconEl(ICONS.box, 'tile__icon');
  const grid = h('div', {
    class: 'minimap minimap--tile', 'aria-hidden': 'true',
    style: `--rows:${unit.grid_rows};--cols:${unit.grid_cols}`,
  });
  const byRC = new Map(state.cells.filter(c => c.unit_id === unit.id)
    .map(c => [c.row + ':' + c.col, c]));
  const filled = new Set();
  state.items.forEach(it => (it.locations || []).forEach(l => {
    if (l.unit_id === unit.id && l.cell_id != null) filled.add(l.cell_id);
  }));
  for (let r = 0; r < unit.grid_rows; r++) {
    for (let c = 0; c < unit.grid_cols; c++) {
      const cell = byRC.get(r + ':' + c);
      let cls = 'minimap__cell';
      if (cell && !isDoorCell(cell)) cls += ' minimap__cell--open';
      else if (cell && filled.has(cell.id)) cls += ' minimap__cell--filled';
      grid.appendChild(h('span', { class: cls }));
    }
  }
  return grid;
}

function countItemsInUnit(unitId) {
  const ids = new Set();
  state.items.forEach(it => {
    if (it.locations && it.locations.some(l => l.unit_id === unitId)) ids.add(it.id);
  });
  return ids.size;
}

function itemsInCell(unitId, cellId) {
  return state.items.filter(it => it.locations &&
    it.locations.some(l => l.unit_id === unitId && l.cell_id === cellId));
}
function itemsInUnitNoCell(unitId) {
  return state.items.filter(it => it.locations &&
    it.locations.some(l => l.unit_id === unitId && l.cell_id == null));
}

// A cell is a trackable "door" unless explicitly 'open'. (kind defaults to 'door' when the
// backend hasn't sent the field yet — keeps old payloads working.)
function isDoorCell(cell) {
  return !!cell && cell.kind !== 'open';
}
// Count ONLY door cells as compartments for a unit.
function countDoorCells(unitId) {
  return state.cells.filter(c => c.unit_id === unitId && isDoorCell(c)).length;
}

// Small door/open legend so the cell mix reads at a glance (browse unit + grid editor share it).
function schematicLegend() {
  return h('div', { class: 'grid-legend grid-legend--compact', 'aria-label': t('legend_short') },
    h('span', { class: 'grid-legend__item' },
      h('span', { class: 'grid-legend__swatch grid-legend__swatch--door' }), t('kind_door')),
    h('span', { class: 'grid-legend__item' },
      h('span', { class: 'grid-legend__swatch grid-legend__swatch--open' }), t('kind_open')),
  );
}

function screenBrowseUnit(unitId, opts = {}) {
  const unit = state.unitById.get(unitId);
  const wrap = h('div', { class: 'screen' });
  if (!unit) { wrap.appendChild(emptyState({ illo: 'grid', title: t('no_units') })); return wrap; }
  const room = state.roomById.get(unit.room_id);
  const lay = unitLayout(unit);
  const head = pageHead(localName(unit), room ? '#/browse/room/' + room.id : '#/browse');
  if (lay === 'closet') {
    head.appendChild(h('a', {
      class: 'btn btn--ghost btn--sm', href: '#/unit/' + unit.id + '/closet',
    }, t('edit_closet')));
  } else if (lay === 'grid') {
    head.appendChild(h('a', {
      class: 'btn btn--ghost btn--sm', href: '#/unit/' + unit.id + '/grid',
    }, t('edit_grid')));
  }
  wrap.appendChild(head);

  // Trackable-compartment count for mapped units.
  if (lay === 'grid' || lay === 'closet') {
    wrap.appendChild(h('p', { class: 'hint hint--count' }, tCount('compartments', countDoorCells(unit.id))));
  }

  // "Add item to this unit" (no specific cell).
  wrap.appendChild(h('a', {
    class: 'btn btn--ghost btn--block', href: '#/add?unit=' + unit.id,
  }, iconEl(ICONS.plus), h('span', null, t('add_to_unit'))));

  // NFC tag on the whole unit (chip + unassign, or an assign action).
  wrap.appendChild(nfcInlineRow('unit', unit.id));

  const detailHost = h('div', { class: 'cell-detail', id: 'cell-detail' });

  if (lay === 'closet') {
    // To-scale closet blueprint; trackable zones open the same contents sheet
    // grid door cells use (identical ?cell= highlight/auto-open plumbing).
    const renderer = closetSchematic(closetLayoutOf(unit), {
      mode: 'browse', unit,
      highlightCellId: opts.highlightCellId != null ? opts.highlightCellId : null,
      onOpen: (cell, btn, rootEl) => showCellItems(unit, cell, detailHost, rootEl, btn),
    });
    wrap.appendChild(renderer);
    wrap.appendChild(h('p', { class: 'hint' }, t('tap_zone')));
    wrap.appendChild(detailHost);
    if (opts.highlightCellId != null) {
      const cell = state.cellById.get(opts.highlightCellId);
      const btn = renderer.querySelector('button.is-hit');
      if (cell && isDoorCell(cell) && btn) showCellItems(unit, cell, detailHost, renderer, btn);
    }
  } else if (unit.grid_rows && unit.grid_cols) {
    const cellsOfUnit = state.cells.filter(c => c.unit_id === unit.id);
    const byRC = new Map(cellsOfUnit.map(c => [c.row + ':' + c.col, c]));
    const grid = h('div', {
      class: 'schematic',
      style: `--rows:${unit.grid_rows};--cols:${unit.grid_cols}`,
      role: 'grid', 'aria-label': localName(unit),
    });
    for (let r = 0; r < unit.grid_rows; r++) {
      for (let c = 0; c < unit.grid_cols; c++) {
        const cell = byRC.get(r + ':' + c);
        const door = isDoorCell(cell);
        if (cell && !door) {
          // OPEN cell: refined display treatment, non-interactive, no count. Not a button.
          // Still gets the is-hit highlight when it's a search/deep-link target
          // (the auto-open below stays door-only — there is nothing to open).
          const openHit = opts.highlightCellId != null && cell.id === opts.highlightCellId;
          grid.appendChild(h('div', {
            class: 'schematic__cell schematic__cell--open' + (openHit ? ' is-hit' : ''),
            role: 'gridcell',
            'aria-label': (cellLabel(cell) || '') + ' · ' + t('kind_open'),
          },
            h('span', { class: 'schematic__label' }, cellLabel(cell) || ''),
            h('span', { class: 'schematic__openhint' }, t('display_label')),
          ));
          continue;
        }
        // DOOR cell (or empty grid slot, treated as door): interactive.
        const count = cell ? itemsInCell(unit.id, cell.id).length : 0;
        const isHit = opts.highlightCellId != null && cell && cell.id === opts.highlightCellId;
        const btn = h('button', {
          class: 'schematic__cell schematic__cell--door' +
            (count ? ' has-items' : ' is-empty') + (isHit ? ' is-hit' : ''),
          type: 'button', role: 'gridcell',
          'aria-label': (cell ? cellLabel(cell) : '') + ' · ' + tCount('items', count),
        },
          h('span', { class: 'schematic__label' }, cell ? cellLabel(cell) : ''),
          count ? h('span', { class: 'schematic__badge' }, String(count))
                : h('span', { class: 'schematic__add', 'aria-hidden': 'true' }, '+'),
        );
        if (cell) btn.addEventListener('click', () => showCellItems(unit, cell, detailHost, grid, btn));
        grid.appendChild(btn);
      }
    }
    wrap.appendChild(grid);
    wrap.appendChild(schematicLegend());
    wrap.appendChild(h('p', { class: 'hint' }, t('tap_door')));
    wrap.appendChild(detailHost);
    // If we arrived via a search hit on a cell, auto-open it (door cells only).
    if (opts.highlightCellId != null) {
      const cell = state.cellById.get(opts.highlightCellId);
      const btn = grid.querySelector('.is-hit');
      if (cell && isDoorCell(cell) && btn) showCellItems(unit, cell, detailHost, grid, btn);
    }
  } else {
    // No layout yet -> invite mapping it as a closet (grid stays available).
    wrap.appendChild(emptyState({
      illo: 'closet', title: t('map_closet_title'), sub: t('map_closet_sub'),
      actionLabel: t('map_closet_cta'), actionHref: '#/unit/' + unit.id + '/closet',
    }));
    wrap.appendChild(h('div', { class: 'center-row' },
      h('a', { class: 'btn btn--ghost btn--sm', href: '#/unit/' + unit.id + '/grid' },
        t('or_use_grid'))));
  }

  // Items with no specific cell in this unit.
  const loose = itemsInUnitNoCell(unit.id);
  if (loose.length) {
    wrap.appendChild(h('h2', { class: 'section-title' }, t('items_here')));
    const cards = h('div', { class: 'cards' });
    loose.forEach(it => cards.appendChild(itemCard(it)));
    wrap.appendChild(cards);
  }
  return wrap;
}

function showCellItems(unit, cell, host, grid, btn) {
  grid.querySelectorAll('.schematic__cell, .closet__zone')
    .forEach(b => b.classList.remove('is-selected'));
  btn.classList.add('is-selected');
  clear(host);
  const items = itemsInCell(unit.id, cell.id);
  host.appendChild(h('h2', { class: 'section-title' },
    (cellLabel(cell) || t('cell')) + ' · ' + tCount('items', items.length)));

  // In-context add into THIS door cell (primary action when the cell is empty).
  const addHere = h('a', {
    class: 'btn btn--block ' + (items.length ? 'btn--ghost' : 'btn--primary'),
    href: '#/add?unit=' + unit.id + '&cell=' + cell.id,
  }, iconEl(ICONS.plus), h('span', null, t('add_here')));
  host.appendChild(addHere);

  // NFC tag on this door compartment.
  host.appendChild(nfcInlineRow('cell', cell.id));

  if (!items.length) {
    host.appendChild(h('p', { class: 'hint' }, t('no_items_here')));
  } else {
    const cards = h('div', { class: 'cards' });
    items.forEach(it => cards.appendChild(itemCard(it)));
    host.appendChild(cards);
  }
  host.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
}

/* ============================================================ *
 *  SCREEN 3 — Item detail                                     *
 * ============================================================ */
async function screenItem(itemId, opts = {}) {
  const wrap = h('div', { class: 'screen screen--item' });
  // Skeleton while we fetch the full item (with open borrow + photo url).
  wrap.appendChild(pageHead(t('item'), '#/'));
  const body = h('div', { class: 'item-detail' }, skeletonCards(1));
  wrap.appendChild(body);

  let item;
  try {
    item = await apiGet('items/' + itemId);
  } catch (e) {
    clear(body);
    body.appendChild(emptyState({ illo: 'box', title: t('item_not_found') }));
    return wrap;
  }
  // Keep local cache fresh.
  upsertItem(item);

  clear(body);

  // #/item/<id>?undo=<borrow_id> (NFC scan reactions): inline undo banner.
  // Built async (may need a borrows fetch) into a placeholder kept at the top.
  if (opts.undoBorrowId != null) {
    const undoHost = h('div', { class: 'undo-host' });
    body.appendChild(undoHost);
    // NOTE: no isConnected guard — the promise can resolve before the router
    // mounts this screen; appending to a detached host is harmless either way.
    buildUndoBanner(item, opts.undoBorrowId).then((el) => {
      if (el) undoHost.appendChild(el);
    });
  }
  // Photo (lazy full image) — or a tasteful line-art placeholder plate.
  if (item.photo_url) {
    body.appendChild(h('div', { class: 'item-detail__photo' },
      h('img', {
        class: 'item-detail__img', loading: 'lazy', decoding: 'async', alt: itemName(item),
        src: new URL(item.photo_url, document.baseURI).href,
      })));
  } else {
    body.appendChild(illoEl('box', 'item-detail__photo item-detail__photo--ph'));
  }

  // Kicker: brand · category as letter-spaced small caps (museum-label meta).
  if (item.brand || item.category) {
    const kick = h('p', { class: 'item-detail__kicker meta-caps' });
    if (item.brand) kick.appendChild(h('bdi', null, item.brand));
    if (item.brand && item.category) kick.appendChild(document.createTextNode(' · '));
    if (item.category) kick.appendChild(h('span', { dir: 'auto' }, item.category));
    body.appendChild(kick);
  }

  // Names (each user field dir="auto"; brand lives in the kicker above).
  const titleBlock = h('div', { class: 'item-detail__titles' });
  const main = h('h1', { class: 'item-detail__name', dir: 'auto' });
  main.textContent = itemName(item);
  titleBlock.appendChild(main);
  // alternate-language names
  ['name_en', 'name_fa', 'name_da'].forEach(key => {
    const lang = key.slice(5);
    if (lang === getLang()) return;
    if (item[key]) {
      const row = h('p', { class: 'item-detail__altname', dir: 'auto', lang });
      row.textContent = item[key];
      titleBlock.appendChild(row);
    }
  });
  body.appendChild(titleBlock);

  body.appendChild(statusChip(item.status));

  // Location plate: mini-map + visual breadcrumb + "show on map" in one
  // bordered paper card (the museum "where to find it" panel).
  body.appendChild(locationCard(item));

  // Meta rows
  const meta = h('dl', { class: 'metalist' });
  const addMeta = (label, value, dir) => {
    if (value == null || value === '') return;
    meta.appendChild(h('dt', null, label));
    const dd = h('dd', dir ? { dir } : null);
    dd.textContent = value;
    meta.appendChild(dd);
  };
  addMeta(t('quantity'), String(item.qty));
  if (item.tags && item.tags.length) {
    meta.appendChild(h('dt', null, t('tags')));
    const dd = h('dd', null);
    item.tags.forEach(tag => dd.appendChild(h('span', { class: 'tag', dir: 'auto' }, tag)));
    meta.appendChild(dd);
  }
  if (item.barcode) {
    meta.appendChild(h('dt', null, t('barcode')));
    const dd = h('dd', null); dd.appendChild(h('bdi', { class: 'mono' }, item.barcode));
    meta.appendChild(dd);
  }
  addMeta(t('notes'), item.notes, 'auto');
  body.appendChild(meta);

  // Borrow state + actions
  body.appendChild(borrowPanel(item));

  // NFC tag assignment (chip + unassign, or an assign action).
  body.appendChild(h('h2', { class: 'section-title' }, t('nfc_tag')));
  body.appendChild(nfcInlineRow('item', item.id));

  // Edit / delete
  const actions = h('div', { class: 'item-detail__actions' },
    h('a', { class: 'btn btn--ghost', href: '#/item/' + item.id + '/edit' },
      iconEl(ICONS.edit), h('span', null, t('edit'))),
    h('button', {
      class: 'btn btn--danger-ghost', type: 'button',
      onclick: () => deleteItem(item),
    }, iconEl(ICONS.trash), h('span', null, t('delete'))),
  );
  body.appendChild(actions);
  return wrap;
}

// Location plate for the item page: mini-map beside the breadcrumb and the
// "show on map" jump (deep-links into the unit schematic with the cell open).
function locationCard(item) {
  const pl = primaryLocation(item);
  const card = h('div', { class: 'loccard' });
  if (!pl || !pl.unit) {
    card.appendChild(h('p', { class: 'breadcrumb breadcrumb--empty' }, t('no_location')));
    return card;
  }
  card.appendChild(h('div', { class: 'loccard__map' }, miniMap(item)));
  const bodyEl = h('div', { class: 'loccard__body' },
    h('span', { class: 'meta-caps' }, t('location')),
    breadcrumb(item));
  if (pl.cell) {
    bodyEl.appendChild(h('a', {
      class: 'btn btn--ghost btn--sm item-detail__showmap',
      href: '#/browse/unit/' + pl.unit.id + '?cell=' + pl.cell.id,
    }, iconEl(ICONS.grid), h('span', null, t('show_on_map'))));
  }
  card.appendChild(bodyEl);
  return card;
}

function borrowPanel(item) {
  const panel = h('div', { class: 'borrow-panel' });
  if (item.borrow) {
    const b = item.borrow;
    panel.appendChild(h('div', { class: 'borrow-panel__info' },
      h('p', { class: 'borrow-panel__who' },
        t('borrowed_by') + ': ', h('bdi', null, b.borrowed_by || '—')),
      h('p', { class: 'borrow-panel__dates' },
        t('borrowed_on') + ': ' + fmtDate(b.borrowed_at) +
        (b.due_at ? ' · ' + t('due') + ': ' + fmtDate(b.due_at) : '')),
    ));
    panel.appendChild(h('button', {
      class: 'btn btn--primary btn--block', type: 'button',
      onclick: () => returnItem(item),
    }, t('return_item')));
  } else {
    panel.appendChild(h('button', {
      class: 'btn btn--primary btn--block', type: 'button',
      onclick: () => openCheckout(item),
    }, iconEl(ICONS.hand), h('span', null, t('check_out'))));
  }
  return panel;
}

// Parse a SQLite timestamp ('YYYY-MM-DD HH:MM:SS', treated as UTC) OR a bare date
// ('YYYY-MM-DD', treated as UTC midnight). Returns a Date, or null if unparseable.
function parseDate(s) {
  if (!s) return null;
  let d;
  if (s.includes('T') || s.includes(' ')) {
    d = new Date(s.replace(' ', 'T') + 'Z');
  } else {
    // bare date -> UTC midnight (avoid 'YYYY-MM-DDZ' which is Invalid Date)
    d = new Date(s + 'T00:00:00Z');
  }
  return isNaN(d) ? null : d;
}

function fmtDate(s) {
  if (!s) return '';
  const d = parseDate(s);
  if (!d) return s;
  try {
    const loc = getLang() === 'fa' ? 'fa-IR' : getLang() === 'da' ? 'da-DK' : 'en-GB';
    return d.toLocaleDateString(loc, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (_) { return d.toISOString().slice(0, 10); }
}

// Date+time (NFC last-scanned stamps). Handles both SQLite 'YYYY-MM-DD HH:MM:SS'
// (UTC, via parseDate) and full ISO strings carrying an explicit offset (HA's
// tag registry sends e.g. '2026-07-02T20:31:04+00:00', which parseDate mangles).
function fmtDateTime(s) {
  if (!s) return '';
  const str = String(s);
  const d = /[Tt].*(Z|[+-]\d{2}:?\d{2})$/.test(str) ? new Date(str) : parseDate(str);
  if (!d || isNaN(d)) return str;
  try {
    const loc = getLang() === 'fa' ? 'fa-IR' : getLang() === 'da' ? 'da-DK' : 'en-GB';
    return d.toLocaleString(loc, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch (_) { return d.toISOString().slice(0, 16).replace('T', ' '); }
}

/* ============================================================ *
 *  Checkout / return / delete (optimistic + undo)             *
 * ============================================================ */
function openCheckout(item) {
  const root = $('#modal-root');
  const overlay = h('div', { class: 'modal-overlay' });
  const close = () => { if (overlay.parentNode) root.removeChild(overlay); };
  const form = h('form', { class: 'modal modal--form', role: 'dialog', 'aria-modal': 'true' });
  form.appendChild(h('h2', { class: 'modal__title' }, t('checkout_title')));
  const whoInput = h('input', { class: 'input', type: 'text',
    placeholder: t('borrowed_by_ph'), 'aria-label': t('borrowed_by'), dir: 'auto' });
  whoInput.addEventListener('input', () => clearFieldError(whoInput));
  const dueInput = h('input', { class: 'input', type: 'date', 'aria-label': t('due_date') });
  form.appendChild(h('label', { class: 'field' },
    h('span', { class: 'field__label' }, t('borrowed_by')), whoInput));
  form.appendChild(h('label', { class: 'field' },
    h('span', { class: 'field__label' }, t('due_date') + ' (' + t('optional') + ')'), dueInput));
  form.appendChild(h('div', { class: 'modal__actions' },
    h('button', { class: 'btn btn--ghost', type: 'button', onclick: close }, t('cancel')),
    h('button', { class: 'btn btn--primary', type: 'submit' }, t('check_out')),
  ));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const who = whoInput.value.trim();
    if (!who) {
      setFieldError(whoInput, t('err_borrower_required'));
      focusFieldError(whoInput);
      return;
    }
    close();
    await doCheckout(item, who, dueInput.value || null);
  });
  overlay.appendChild(form);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  root.appendChild(overlay);
  whoInput.focus();
}

async function doCheckout(item, who, due) {
  // optimistic
  const prevStatus = item.status;
  item.status = 'borrowed';
  upsertItem(item);
  toast(t('toast_checked_out', { name: itemName(item), who }), {
    undo: async () => {
      try { await apiSend('POST', 'items/' + item.id + '/return'); await refreshItem(item.id); route(); }
      catch (_) {}
    },
  });
  try {
    const res = await apiSend('POST', 'items/' + item.id + '/checkout',
      { borrowed_by: who, qty: 1, due_at: due, note: '' });
    if (res && res.item) upsertItem(res.item);
    await reloadBorrows();
    route();
  } catch (e) {
    item.status = prevStatus; upsertItem(item);
    toast(t('toast_error'), { kind: 'error' });
    route();
  }
}

// Return a CACHED item: optimistic status flip + index rebuild, with rollback on error.
async function returnItem(item) {
  const prevStatus = item.status;
  item.status = 'in_stock';
  upsertItem(item);
  toast(t('toast_returned', { name: itemName(item) }));
  try {
    const res = await apiSend('POST', 'items/' + item.id + '/return');
    if (res && res.item) upsertItem(res.item);
    await reloadBorrows();
    route();
  } catch (e) {
    item.status = prevStatus; upsertItem(item);
    toast(t('toast_error'), { kind: 'error' });
    route();
  }
}

// Borrow-only return used by the Borrowed view when the item isn't in the local cache.
// Does NOT push a synthetic stub into state.items / Fuse — it only closes the borrow and
// refreshes the cached copy if (and only if) the server returns the real item.
async function returnBorrowOnly(itemId, displayName) {
  toast(t('toast_returned', { name: displayName }));
  try {
    const res = await apiSend('POST', 'items/' + itemId + '/return');
    if (res && res.item) upsertItem(res.item);
    await reloadBorrows();
    route();
  } catch (e) {
    toast(t('toast_error'), { kind: 'error' });
    route();
  }
}

/* ---- NFC undo banner (#/item/<id>?undo=<borrow_id>) ---------------------
 * Honest undo semantics against the existing endpoints:
 *   - undo a checkout  -> POST items/<id>/return {borrow_id} (closes exactly
 *     that borrow — supported natively by the return endpoint).
 *   - undo a check-in  -> re-checkout with the closed borrow's fields (there
 *     is no "reopen borrow" endpoint; a fresh borrow row is the honest subset).
 */
function undoBannerEl(msgKey, onUndo) {
  const btn = h('button', { class: 'btn btn--primary btn--sm', type: 'button' }, t('undo'));
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await onUndo(); }
    catch (_) { btn.disabled = false; toast(t('toast_error'), { kind: 'error' }); }
  });
  return h('div', { class: 'undo-banner' },
    h('span', { class: 'undo-banner__msg' }, t(msgKey)), btn);
}

async function buildUndoBanner(item, undoId) {
  // The undo target: the item's open borrow if ids match, else look the borrow
  // up in the full list (needed for check-ins, where the borrow is closed).
  let b = (item.borrow && item.borrow.id === undoId) ? item.borrow : null;
  if (!b) {
    try {
      const res = await apiGet('borrows');
      b = res && res.borrows
        ? res.borrows.find(x => x.id === undoId && x.item_id === item.id) || null
        : null;
    } catch (_) { b = null; }
  }
  if (!b) return null;

  if (!b.returned_at) {
    // Open borrow -> this was a checkout; undo returns exactly that borrow.
    return undoBannerEl('nfc_undo_checkout', async () => {
      const res = await apiSend('POST', 'items/' + item.id + '/return', { borrow_id: undoId });
      if (res && res.item) upsertItem(res.item);
      await reloadBorrows();
      toast(t('toast_returned', { name: itemName(item) }));
      nav('#/item/' + item.id);
    });
  }
  // Closed borrow -> this was a check-in; undo re-opens by checking out again.
  return undoBannerEl('nfc_undo_checkin', async () => {
    const who = b.borrowed_by || 'NFC';
    const res = await apiSend('POST', 'items/' + item.id + '/checkout',
      { borrowed_by: who, qty: b.qty || 1, due_at: b.due_at || null, note: b.note || '' });
    if (res && res.item) upsertItem(res.item);
    await reloadBorrows();
    toast(t('toast_checked_out', { name: itemName(item), who }));
    nav('#/item/' + item.id);
  });
}

async function deleteItem(item) {
  // Optimistic remove with undo window before committing the DELETE.
  const idx = state.items.findIndex(i => i.id === item.id);
  if (idx >= 0) state.items.splice(idx, 1);
  state.itemById.delete(item.id);
  buildFuse();
  let committed = false;
  let undone = false;
  location.hash = '#/';
  const commit = async () => {
    if (undone || committed) return;
    committed = true;
    try { await apiSend('DELETE', 'items/' + item.id); }
    catch (e) { /* restore on failure */ state.items.push(item); rebuildIndexes(); buildFuse(); toast(t('toast_error'), { kind: 'error' }); route(); }
  };
  toast(t('toast_deleted', { name: itemName(item) }), {
    duration: 6000,
    undo: () => {
      undone = true;
      state.items.push(item); rebuildIndexes(); buildFuse();
      location.hash = '#/item/' + item.id;
    },
  });
  setTimeout(commit, 6200);
}

/* ============================================================ *
 *  SCREEN 4 — Add / Edit                                      *
 * ============================================================ */
function blankItem() {
  return { id: null, name_en: '', name_fa: '', name_da: '', brand: '', category: '',
    qty: 1, tags: [], barcode: '', barcode_format: '', notes: '',
    photo_url: null, thumb_url: null, status: 'in_stock', locations: [] };
}

async function screenAddEdit(itemId, preselect) {
  const isEdit = itemId != null;
  const wrap = h('div', { class: 'screen screen--form' });
  wrap.appendChild(pageHead(isEdit ? t('edit_item') : t('add_item'), isEdit ? '#/item/' + itemId : '#/'));

  let model;
  if (isEdit) {
    const cached = state.itemById.get(itemId);
    model = cached ? JSON.parse(JSON.stringify(cached)) : null;
    if (!model) {
      try { model = await apiGet('items/' + itemId); } catch (_) { model = null; }
    }
    if (!model) { wrap.appendChild(emptyState({ illo: 'box', title: t('item_not_found') })); return wrap; }
    model.tags = model.tags || [];
  } else {
    model = blankItem();
    // #/add?barcode=<code> (from the home-screen scan flow) prefills the barcode.
    if (preselect && preselect.barcode && !model.barcode) {
      model.barcode = normalizeBarcode(preselect.barcode);
    }
  }

  const form = h('form', { class: 'form' });

  // --- Photo + scan capture row ---
  const photoState = { url: model.photo_url, file: null };
  const photoBox = h('div', { class: 'capture' });
  function renderPhoto() {
    clear(photoBox);
    if (photoState.file) {
      photoBox.appendChild(h('img', { class: 'capture__img', alt: '',
        src: URL.createObjectURL(photoState.file) }));
    } else if (photoState.url) {
      photoBox.appendChild(h('img', { class: 'capture__img', alt: '',
        src: new URL(photoState.url, document.baseURI).href }));
    } else {
      photoBox.appendChild(h('div', { class: 'capture__ph' }, iconEl(ICONS.camera, 'capture__icon'),
        h('span', null, t('add_photo'))));
    }
  }
  renderPhoto();
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment',
    class: 'sr-only', id: 'photo-file' });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) { photoState.file = fileInput.files[0]; renderPhoto(); }
  });
  const captureRow = h('div', { class: 'capture-row' },
    photoBox,
    h('div', { class: 'capture-row__btns' },
      h('button', { class: 'btn btn--ghost', type: 'button',
        onclick: () => fileInput.click() }, iconEl(ICONS.camera),
        h('span', null, photoState.url || photoState.file ? t('replace_photo') : t('take_photo'))),
      (photoState.url || photoState.file) ? h('button', {
        class: 'btn btn--danger-ghost', type: 'button',
        onclick: () => { photoState.file = null; photoState.url = null; model.photo_removed = true; renderPhoto(); },
      }, t('remove_photo')) : null,
    ),
  );
  form.appendChild(fileInput);
  form.appendChild(captureRow);

  // --- Barcode: a VISIBLE, editable field with an inline scan button. ---
  // Scanned values show a sage "Scanned" chip; the Open Food Facts lookup
  // reports its progress inline right under the field (never dead air).
  const bcInput = h('input', {
    class: 'input mono codefield__input', type: 'text', value: model.barcode || '',
    dir: 'ltr', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    placeholder: t('barcode_ph'), 'aria-label': t('barcode'),
  });
  const bcScan = h('button', { class: 'btn btn--ghost codefield__scan', type: 'button' },
    iconEl(ICONS.camera), h('span', null, t('scan_barcode')));
  const bcChip = h('span', { class: 'chip chip--scanned', hidden: true },
    iconEl(ICONS.check), h('span', null, t('barcode_scanned')));
  const bcStatus = h('span', { class: 'lookup-status', hidden: true });
  const bcField = h('div', { class: 'field' },
    h('span', { class: 'field__label' }, t('barcode')),
    h('div', { class: 'codefield' }, bcInput, bcScan),
    h('div', { class: 'codefield__meta' }, bcChip, bcStatus),
  );
  form.appendChild(bcField);

  // Best-effort product lookup with inline status. A sequence counter drops
  // stale responses (rescan / manual edit while a lookup is in flight).
  let lookupSeq = 0;
  let lookupImage = null;   // product image URL from the last successful lookup
  async function runLookup(rawCode) {
    const seq = ++lookupSeq;
    bcStatus.hidden = false;
    bcStatus.className = 'lookup-status lookup-status--busy';
    clear(bcStatus);
    bcStatus.appendChild(h('span', { class: 'lookup-status__spin', 'aria-hidden': 'true' }));
    bcStatus.appendChild(h('span', null, t('looking_up')));
    announce(t('looking_up'));
    let data = null;
    try { data = await apiGet('lookup/' + encodeURIComponent(normalizeBarcode(rawCode))); }
    catch (_) { data = null; /* offline / proxy failure -> same as a miss */ }
    if (seq !== lookupSeq) return; // superseded
    clear(bcStatus);
    if (data && (data.name || data.brand)) {
      if (data.name && !fEn.input.value) { fEn.input.value = data.name; clearFieldError(fEn.input); }
      if (data.brand && !fBrand.input.value) fBrand.input.value = data.brand;
      // Offer the product image as the photo when the user has none yet.
      // https only: mixed-content http images (some UPCitemdb hits) would be
      // blocked in the browser and can't be stored server-side either.
      if (data.image && /^https:/i.test(data.image) && !photoState.file && !photoState.url) {
        lookupImage = data.image; photoState.url = data.image; renderPhoto();
      }
      const nm = data.name || data.brand;
      bcStatus.className = 'lookup-status lookup-status--found';
      bcStatus.appendChild(iconEl(ICONS.check));
      bcStatus.appendChild(h('span', null, t('lookup_found_pre') + ' '));
      bcStatus.appendChild(h('bdi', null, nm));
      bcStatus.appendChild(h('span', null, ' — ' + t('lookup_found_post')));
      announce(t('lookup_found_pre') + ' ' + nm + ' — ' + t('lookup_found_post'));
    } else {
      bcStatus.className = 'lookup-status lookup-status--miss';
      bcStatus.appendChild(h('span', null, t('lookup_miss')));
      announce(t('lookup_miss'));
    }
  }

  bcScan.addEventListener('click', async () => {
    const result = await openScanner();
    if (!result) return;
    const code = normalizeBarcode(result.rawValue);
    bcInput.value = code;
    model.barcode = code;
    model.barcode_format = result.format || null;
    bcChip.hidden = false;
    runLookup(code);
  });
  bcInput.addEventListener('input', () => {
    // Hand-edited: it's no longer the scanned value — drop format + chip,
    // and cancel any in-flight lookup so it can't overwrite fields later.
    model.barcode = bcInput.value.trim();
    model.barcode_format = null;
    bcChip.hidden = true;
    bcStatus.hidden = true;
    lookupSeq++;
    // Drop a stale lookup image if it's still the one being shown.
    if (lookupImage && photoState.url === lookupImage && !photoState.file) {
      lookupImage = null; photoState.url = null; renderPhoto();
    }
  });

  // --- Name fields (all three languages) ---
  const fieldText = (key, label, opts = {}) => {
    const input = h('input', { class: 'input', type: 'text', value: model[key] || '',
      'data-key': key, dir: opts.dir || 'auto', placeholder: opts.ph || '',
      inputmode: opts.inputmode || undefined, lang: opts.lang || undefined });
    return { wrap: h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), input), input };
  };
  const fEn = fieldText('name_en', t('name_en'), { lang: 'en' });
  const fFa = fieldText('name_fa', t('name_fa'), { lang: 'fa' });
  const fDa = fieldText('name_da', t('name_da'), { lang: 'da' });
  // Any of the three names satisfies the "give it a name" rule — typing in any
  // of them clears the inline error shown under the English name field.
  [fEn, fFa, fDa].forEach(f =>
    f.input.addEventListener('input', () => clearFieldError(fEn.input)));
  const fBrand = fieldText('brand', t('brand'));
  const fCat = fieldText('category', t('category'), { ph: t('category_ph') });
  const fTags = fieldText('_tags', t('tags'), { ph: t('tags_ph') });
  fTags.input.value = (model.tags || []).join(', ');
  const fNotes = (() => {
    const ta = h('textarea', { class: 'input input--area', rows: '3', 'data-key': 'notes',
      dir: 'auto', placeholder: t('notes_ph') }, model.notes || '');
    return { wrap: h('label', { class: 'field' }, h('span', { class: 'field__label' }, t('notes')), ta), input: ta };
  })();
  const fQty = (() => {
    const input = h('input', { class: 'input input--num', type: 'number', min: '0', step: '1',
      value: String(model.qty != null ? model.qty : 1), 'data-key': 'qty', inputmode: 'numeric' });
    return { wrap: h('label', { class: 'field field--num' }, h('span', { class: 'field__label' }, t('quantity')), input), input };
  })();

  form.appendChild(fEn.wrap);
  form.appendChild(fFa.wrap);
  form.appendChild(fDa.wrap);
  form.appendChild(fBrand.wrap);
  const grid2 = h('div', { class: 'form__row2' }, fCat.wrap, fQty.wrap);
  form.appendChild(grid2);
  form.appendChild(fTags.wrap);

  // --- Status (edit only) --- 'borrowed' is owned by the borrow flow: shown
  // read-only while an item is out; otherwise a manual in_stock/lost/archived pick.
  let statusSel = null;
  if (isEdit) {
    if (model.status === 'borrowed') {
      form.appendChild(h('div', { class: 'field' },
        h('span', { class: 'field__label' }, t('status')),
        h('div', { class: 'field__static' }, statusChip('borrowed')),
        h('span', { class: 'field__hint' }, t('status_borrowed_note')),
      ));
    } else {
      statusSel = h('select', { class: 'input', 'aria-label': t('status') });
      ['in_stock', 'lost', 'archived'].forEach(s => {
        statusSel.appendChild(h('option', {
          value: s, ...(model.status === s ? { selected: true } : {}),
        }, t(s)));
      });
      form.appendChild(h('label', { class: 'field' },
        h('span', { class: 'field__label' }, t('status')), statusSel));
    }
  }

  // --- Location picker (room -> unit -> cell); honors in-context preselect ---
  const locPicker = buildLocationPicker(model, isEdit ? null : preselect);
  form.appendChild(locPicker.el);

  form.appendChild(fNotes.wrap);

  // --- Actions ---
  const submitBtn = h('button', { class: 'btn btn--primary btn--block', type: 'submit' },
    isEdit ? t('save') : t('add_item'));
  form.appendChild(h('div', { class: 'form__actions' },
    h('a', { class: 'btn btn--ghost', href: isEdit ? '#/item/' + itemId : '#/' }, t('cancel')),
    submitBtn));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const bcVal = normalizeBarcode(bcInput.value.trim());
    const payload = {
      name_en: fEn.input.value.trim(),
      name_fa: fFa.input.value.trim(),
      name_da: fDa.input.value.trim(),
      brand: fBrand.input.value.trim(),
      category: fCat.input.value.trim(),
      qty: parseInt(fQty.input.value, 10) || 0,
      tags: fTags.input.value.split(',').map(s => s.trim()).filter(Boolean),
      barcode: bcVal || null,
      barcode_format: (bcVal && model.barcode_format) || null,
      notes: fNotes.input.value.trim(),
      locations: locPicker.getLocations(),
    };
    // Only send status when the user actually changed it: the form snapshot
    // can go stale while open (e.g. an NFC scan checks the item out), and
    // PATCHing the old value back would leave an open borrow on an
    // 'in_stock' item. The server PATCH only updates provided keys.
    if (statusSel && statusSel.value !== model.status) payload.status = statusSel.value;
    // Tell the server which language the user typed in, so it can auto-translate
    // the empty name languages (no-op unless a Google Translate key is set).
    payload.source_lang = getLang();
    // Persist the barcode-lookup product image when it's the shown photo and the
    // user didn't take/choose their own — the server fetches + stores it.
    if (lookupImage && !photoState.file && photoState.url === lookupImage) {
      payload.image_url = lookupImage;
    }
    if (!payload.name_en && !payload.name_fa && !payload.name_da) {
      // Inline field-level error (primary) + toast (secondary). The rule is
      // client-side by design: the server accepts nameless items, but an
      // unnamed item is unfindable, so the form insists on one name.
      setFieldError(fEn.input, t('err_name_required'));
      toast(t('name_required'), { kind: 'error' });
      focusFieldError(fEn.input);
      return;
    }
    submitBtn.disabled = true; submitBtn.textContent = t('saving');
    try {
      let saved;
      if (isEdit) saved = await apiSend('PATCH', 'items/' + itemId, payload);
      else saved = await apiSend('POST', 'items', payload);

      // photo upload (after we have an id)
      if (photoState.file && saved && saved.id != null) {
        try {
          const fd = new FormData();
          fd.append('file', photoState.file);
          const up = await apiJSON('items/' + saved.id + '/photo', { method: 'POST', body: fd });
          if (up) { saved.photo_url = up.photo_url; saved.thumb_url = up.thumb_url; }
        } catch (_) { /* photo failure shouldn't lose the item */ }
      } else if (isEdit && model.photo_removed && !photoState.file) {
        try { await apiSend('DELETE', 'items/' + itemId + '/photo'); saved.photo_url = null; saved.thumb_url = null; }
        catch (_) {}
      }
      upsertItem(saved);
      toast(isEdit ? t('toast_updated', { name: itemName(saved) }) : t('toast_added', { name: itemName(saved) }));
      location.hash = '#/item/' + saved.id;
    } catch (err) {
      submitBtn.disabled = false; submitBtn.textContent = isEdit ? t('save') : t('add_item');
      toast(t('toast_error'), { kind: 'error' });
    }
  });

  wrap.appendChild(form);

  // Arrived via #/add?barcode=<code> (home-screen scan with no owner): the
  // code IS from a scan — show the chip and run the product lookup right
  // away so the user sees the barcode working, not a silently blank form.
  if (!isEdit && model.barcode) {
    bcChip.hidden = false;
    setTimeout(() => runLookup(model.barcode), 0);
  }
  return wrap;
}

function buildLocationPicker(model, preselect) {
  // `preselect` (from hash params) wins over any existing location, so in-context add
  // (#/add?unit=1&cell=12) pre-fills room -> unit -> cell.
  let existing = (model.locations && model.locations[0]) || null;
  if (preselect && preselect.unit_id) {
    existing = { unit_id: preselect.unit_id, cell_id: preselect.cell_id != null ? preselect.cell_id : null };
  }
  let roomId = '';
  if (existing) {
    const unit = state.unitById.get(existing.unit_id);
    if (unit) roomId = unit.room_id;
  }
  const el = h('div', { class: 'field locpicker' });
  el.appendChild(h('span', { class: 'field__label' }, t('pick_location')));

  const roomSel = h('select', { class: 'input', 'aria-label': t('pick_room') });
  roomSel.appendChild(h('option', { value: '' }, '— ' + t('pick_room') + ' —'));
  state.rooms.slice().sort((a, b) => a.sort_order - b.sort_order).forEach(r => {
    roomSel.appendChild(h('option', { value: String(r.id), ...(r.id === roomId ? { selected: true } : {}) }, localName(r)));
  });

  const unitSel = h('select', { class: 'input', 'aria-label': t('pick_unit') });
  const cellSel = h('select', { class: 'input', 'aria-label': t('pick_cell') });
  const zoneHost = h('div', { class: 'locpicker__zones' });
  // Closet units pick their zone on the schematic instead of a dropdown.
  let zoneCellId = existing && existing.cell_id != null ? existing.cell_id : null;

  function renderZonePick() {
    clear(zoneHost);
    const uid = parseInt(unitSel.value, 10);
    const unit = state.unitById.get(uid);
    if (!unit || unitLayout(unit) !== 'closet') return;
    zoneHost.appendChild(h('p', { class: 'hint' }, t('pick_zone_hint')));
    zoneHost.appendChild(closetSchematic(closetLayoutOf(unit), {
      mode: 'picker', selectedCellId: zoneCellId,
      onPick: (cell) => {
        zoneCellId = zoneCellId === cell.id ? null : cell.id;
        renderZonePick();
      },
    }));
    const selCell = zoneCellId != null ? state.cellById.get(zoneCellId) : null;
    zoneHost.appendChild(h('p', { class: 'hint hint--count' },
      selCell ? (cellLabel(selCell) || t('cell')) : t('no_cell')));
  }

  function fillUnits() {
    clear(unitSel);
    unitSel.appendChild(h('option', { value: '' }, '— ' + t('pick_unit') + ' —'));
    const rid = parseInt(roomSel.value, 10);
    state.units.filter(u => u.room_id === rid).sort((a, b) => a.sort_order - b.sort_order)
      .forEach(u => {
        const sel = existing && existing.unit_id === u.id;
        unitSel.appendChild(h('option', { value: String(u.id), ...(sel ? { selected: true } : {}) }, localName(u)));
      });
    fillCells();
  }
  function fillCells() {
    clear(cellSel);
    clear(zoneHost);
    cellSel.appendChild(h('option', { value: '' }, t('no_cell')));
    const uid = parseInt(unitSel.value, 10);
    const unit = state.unitById.get(uid);
    // Drop a zone selection that no longer matches the picked unit.
    if (zoneCellId != null) {
      const zc = state.cellById.get(zoneCellId);
      if (!zc || !unit || zc.unit_id !== unit.id) zoneCellId = null;
    }
    if (unit && unitLayout(unit) === 'closet') {
      cellSel.hidden = true;
      cellSel.disabled = true;
      renderZonePick();
      return;
    }
    cellSel.hidden = false;
    if (!unit || !unit.grid_rows) { cellSel.disabled = true; return; }
    cellSel.disabled = false;
    // Only DOOR cells are assignable — open (exposed display) cells are never selectable.
    state.cells.filter(c => c.unit_id === uid && isDoorCell(c))
      .sort((a, b) => (a.row - b.row) || (a.col - b.col))
      .forEach(c => {
        const sel = existing && existing.cell_id === c.id;
        cellSel.appendChild(h('option', { value: String(c.id), ...(sel ? { selected: true } : {}) },
          cellLabel(c) || (c.row + 1) + '×' + (c.col + 1)));
      });
  }
  roomSel.addEventListener('change', fillUnits);
  unitSel.addEventListener('change', fillCells);
  fillUnits();

  el.appendChild(roomSel);
  el.appendChild(unitSel);
  el.appendChild(cellSel);
  el.appendChild(zoneHost);

  return {
    el,
    getLocations() {
      const uid = parseInt(unitSel.value, 10);
      if (!uid) return [];
      const unit = state.unitById.get(uid);
      const cid = (unit && unitLayout(unit) === 'closet')
        ? (zoneCellId || null)
        : (parseInt(cellSel.value, 10) || null);
      return [{ unit_id: uid, cell_id: cid, qty_here: model.qty || 1, is_primary: 1 }];
    },
  };
}

/* ============================================================ *
 *  SCREEN 5 — Unit grid editor                                *
 * ============================================================ */
async function screenGridEditor(unitId) {
  const unit = state.unitById.get(unitId);
  const wrap = h('div', { class: 'screen screen--grid' });
  if (!unit) { wrap.appendChild(emptyState({ illo: 'grid', title: t('no_units') })); return wrap; }
  if (unitLayout(unit) === 'closet') {
    // Closet units are edited in the composer; conversion happens there.
    location.replace('#/unit/' + unitId + '/closet');
    return wrap;
  }
  wrap.appendChild(pageHead(t('grid_editor') + ' · ' + localName(unit), '#/browse/unit/' + unit.id));
  wrap.appendChild(h('p', { class: 'hint' }, t('grid_help')));

  // working copy of cells (row,col -> label, and row,col -> kind)
  let rows = unit.grid_rows || 0;
  let cols = unit.grid_cols || 0;
  const labelMap = new Map(); // "r:c" -> label_en (edited here)
  const faMap = new Map();    // "r:c" -> label_fa (NOT edited here; preserved on save)
  const daMap = new Map();    // "r:c" -> label_da (NOT edited here; preserved on save)
  const kindMap = new Map();  // "r:c" -> 'door' | 'open'
  state.cells.filter(c => c.unit_id === unitId).forEach(c => {
    labelMap.set(c.row + ':' + c.col, c.label_en || '');
    faMap.set(c.row + ':' + c.col, c.label_fa || '');
    daMap.set(c.row + ':' + c.col, c.label_da || '');
    kindMap.set(c.row + ':' + c.col, c.kind === 'open' ? 'open' : 'door');
  });

  const controls = h('div', { class: 'grid-controls' });
  const rowsInput = h('input', { class: 'input input--num', type: 'number', min: '0', max: '20',
    value: String(rows), 'aria-label': t('rows') });
  const colsInput = h('input', { class: 'input input--num', type: 'number', min: '0', max: '20',
    value: String(cols), 'aria-label': t('cols') });
  controls.appendChild(h('label', { class: 'field field--num' },
    h('span', { class: 'field__label' }, t('rows')), rowsInput));
  controls.appendChild(h('label', { class: 'field field--num' },
    h('span', { class: 'field__label' }, t('cols')), colsInput));
  const applyBtn = h('button', { class: 'btn btn--ghost', type: 'button' }, t('apply_grid'));
  controls.appendChild(applyBtn);
  wrap.appendChild(controls);
  rowsInput.addEventListener('input', () => clearFieldError(rowsInput));
  colsInput.addEventListener('input', () => clearFieldError(colsInput));

  // Legend + kind toggle help.
  wrap.appendChild(h('div', { class: 'grid-legend' },
    h('span', { class: 'grid-legend__item' },
      h('span', { class: 'grid-legend__swatch grid-legend__swatch--door' }), t('kind_door')),
    h('span', { class: 'grid-legend__item' },
      h('span', { class: 'grid-legend__swatch grid-legend__swatch--open' }), t('kind_open')),
    h('span', { class: 'grid-legend__text' }, t('grid_legend')),
  ));
  wrap.appendChild(h('p', { class: 'hint' }, t('grid_kind_help')));

  const gridHost = h('div', { class: 'grid-edit-host' });
  wrap.appendChild(gridHost);

  function renderGrid() {
    clear(gridHost);
    if (!rows || !cols) {
      gridHost.appendChild(h('p', { class: 'hint' }, t('no_cells')));
      return;
    }
    const grid = h('div', { class: 'schematic schematic--edit',
      style: `--rows:${rows};--cols:${cols}` });
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const key = r + ':' + c;
        if (!kindMap.has(key)) kindMap.set(key, 'door');
        const cellEl = h('div', {
          class: 'schematic__cell schematic__cell--edit',
          'data-kind': kindMap.get(key),
        });
        const input = h('input', {
          class: 'schematic__input', type: 'text', value: labelMap.get(key) || '',
          'aria-label': t('cell_label') + ' ' + (r + 1) + '×' + (c + 1), dir: 'auto',
        });
        input.addEventListener('input', () => labelMap.set(key, input.value));
        // Per-cell door/open toggle (tap to cycle).
        const toggle = h('button', {
          class: 'schematic__kind', type: 'button',
          'aria-label': t('kind_door') + ' / ' + t('kind_open'),
          'aria-pressed': kindMap.get(key) === 'open' ? 'true' : 'false',
        }, kindMap.get(key) === 'open' ? t('kind_open') : t('kind_door'));
        toggle.addEventListener('click', () => {
          const next = kindMap.get(key) === 'open' ? 'door' : 'open';
          kindMap.set(key, next);
          cellEl.setAttribute('data-kind', next);
          toggle.textContent = next === 'open' ? t('kind_open') : t('kind_door');
          toggle.setAttribute('aria-pressed', next === 'open' ? 'true' : 'false');
        });
        cellEl.appendChild(input);
        cellEl.appendChild(toggle);
        grid.appendChild(cellEl);
      }
    }
    gridHost.appendChild(grid);
  }
  renderGrid();

  applyBtn.addEventListener('click', () => {
    // Range 0–20 matches the server clamp in api_unit_create/api_unit_update.
    // Out-of-range values get an inline error instead of a silent clamp.
    const rv = parseInt(rowsInput.value, 10);
    const cv = parseInt(colsInput.value, 10);
    const rOk = Number.isInteger(rv) && rv >= 0 && rv <= 20;
    const cOk = Number.isInteger(cv) && cv >= 0 && cv <= 20;
    if (!rOk) setFieldError(rowsInput, t('err_grid_range'));
    if (!cOk) setFieldError(colsInput, t('err_grid_range'));
    if (!rOk || !cOk) { focusFieldError(!rOk ? rowsInput : colsInput); return; }
    rows = rv; cols = cv;
    rowsInput.value = String(rows); colsInput.value = String(cols);
    renderGrid();
  });

  const saveBtn = h('button', { class: 'btn btn--primary btn--block', type: 'button' }, t('save_grid'));
  saveBtn.addEventListener('click', async () => {
    // NFC tags assigned to cells that stop being doors (kind toggled to
    // 'open', or dropped by shrinking the grid) are deleted server-side by
    // the bulk-replace PUT — warn and confirm instead of losing them silently.
    const lostTags = state.nfc_tags.filter(tg => {
      if (tg.target_kind !== 'cell') return false;
      const cell = state.cellById.get(tg.target_id);
      if (!cell || cell.unit_id !== unitId) return false;
      if (cell.row >= rows || cell.col >= cols) return true;
      return kindMap.get(cell.row + ':' + cell.col) !== 'door';
    });
    if (lostTags.length) {
      // DOM message (not string templating) so LTR tag ids sit in <bdi>
      // inside RTL text.
      const msg = h('span', null, t('grid_tags_lost_pre'), ' ');
      lostTags.forEach((tg, i) => {
        if (i) msg.appendChild(document.createTextNode(getLang() === 'fa' ? '، ' : ', '));
        msg.appendChild(h('bdi', null, tg.name || shortTagId(tg.tag_id)));
      });
      msg.appendChild(document.createTextNode(' — ' + t('grid_tags_lost_post')));
      if (!(await confirmDialog(msg, { confirmLabel: t('save_grid'), danger: true }))) return;
    }
    saveBtn.disabled = true; saveBtn.textContent = t('saving');
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const key = r + ':' + c;
        cells.push({ row: r, col: c, row_span: 1, col_span: 1,
          label_en: labelMap.get(key) || '',
          // fa/da aren't editable in this editor — send back what was loaded so
          // the bulk-replace PUT can't wipe Persian/Danish labels.
          label_fa: faMap.get(key) || '', label_da: daMap.get(key) || '',
          kind: kindMap.get(key) === 'open' ? 'open' : 'door' });
      }
    }
    try {
      // Update the unit's grid dims, then bulk-replace cells.
      await apiSend('PATCH', 'units/' + unitId, { grid_rows: rows, grid_cols: cols });
      await apiSend('PUT', 'units/' + unitId + '/cells', { cells });
      await loadBootstrap();
      toast(t('toast_saved'));
      location.hash = '#/browse/unit/' + unitId;
    } catch (e) {
      saveBtn.disabled = false; saveBtn.textContent = t('save_grid');
      toast(t('toast_error'), { kind: 'error' });
    }
  });
  wrap.appendChild(h('div', { class: 'form__actions' },
    h('a', { class: 'btn btn--ghost', href: '#/browse/unit/' + unitId }, t('cancel')), saveBtn));
  return wrap;
}

/* ============================================================ *
 *  SCREEN 5b — Closet composer (sections + zones, to-scale)   *
 * ============================================================ */
// Build/edit a closet layout: start from a template (or empty), tune each
// section (width, corner) and its zones (kind, height or "Rest", label) with
// a live to-scale preview, then save via PUT /api/units/<id>/layout (which
// switches a 'none'/'grid' unit to 'closet'). Before saving we warn about any
// items or NFC tags that dropped/opened zones would lose — matching exactly
// what the server degrades (see api_unit_layout_put).
const CLOSET_KINDS = ['shelf', 'drawer', 'hanging', 'basket', 'open'];

function ccZone(kind = 'shelf') {
  return { kind, height_cm: null, label_en: '', label_fa: '', label_da: '' };
}
function ccSection() {
  return { width_cm: 50, corner: false, zones: [ccZone('shelf')] };
}
// Deep clone a template / layout payload into an editable working model.
function ccClone(src) {
  return {
    height_cm: src.height_cm != null ? src.height_cm : 236,
    sections: (src.sections || []).map(s => ({
      width_cm: s.width_cm != null ? s.width_cm : 50,
      corner: !!s.corner,
      zones: (s.zones || []).map(z => ({
        kind: CLOSET_KINDS.includes(z.kind) ? z.kind : 'shelf',
        height_cm: z.height_cm != null ? z.height_cm : null,
        label_en: z.label_en || '', label_fa: z.label_fa || '', label_da: z.label_da || '',
      })),
    })),
  };
}

async function screenClosetEditor(unitId) {
  const unit = state.unitById.get(unitId);
  const wrap = h('div', { class: 'screen screen--closet' });
  if (!unit) { wrap.appendChild(emptyState({ illo: 'closet', title: t('no_units') })); return wrap; }
  const backHash = '#/browse/unit/' + unit.id;
  const curLayout = unitLayout(unit);
  const isGrid = curLayout === 'grid';
  wrap.appendChild(pageHead(t('closet_editor') + ' · ' + localName(unit), backHash));
  if (isGrid) wrap.appendChild(h('p', { class: 'hint' }, t('switch_to_closet')));
  wrap.appendChild(h('p', { class: 'hint' }, t('closet_help')));

  const host = h('div', { class: 'closet-host' });
  wrap.appendChild(host);

  // Working model + view state.
  let model = { height_cm: unit.height_cm != null ? unit.height_cm : 236, sections: [] };
  let picked = false;         // moved past the template picker?
  let templates = [];
  let errors = {};
  let previewBody = null;

  // Seed the model from an existing closet (authoritative labels/heights).
  if (curLayout === 'closet') {
    try {
      const lay = await apiGet('units/' + unit.id + '/layout');
      if (lay && (lay.sections || []).length) { model = ccClone(lay); picked = true; }
    } catch (_) { /* fall back to the picker */ }
  }
  // Named starting points (best-effort; picker still offers "start empty").
  try {
    const res = await apiGet('units/layout_templates');
    templates = (res && res.templates) || [];
  } catch (_) { templates = []; }

  const toLayout = () => ({ height_cm: Number(model.height_cm) || 236, sections: model.sections });
  const localField = (obj, base) => obj[base + '_' + getLang()] || obj[base + '_en'] || '';

  function redrawPreview() {
    if (!previewBody) return;
    clear(previewBody);
    previewBody.appendChild(closetSchematic(toLayout(), { mode: 'preview' }));
  }

  // ----- template picker ---------------------------------------------------
  function renderPicker() {
    host.appendChild(h('h2', { class: 'section-title' }, t('tpl_pick_title')));
    host.appendChild(h('p', { class: 'hint' }, t('tpl_pick_sub')));
    const grid = h('div', { class: 'tpl-grid' });

    const empty = h('button', { class: 'tpl-card tpl-card--empty', type: 'button' },
      h('div', { class: 'tpl-card__prev' }, illoEl('closet')),
      h('span', { class: 'tpl-card__name' }, t('tpl_empty')),
      h('span', { class: 'tpl-card__sub' }, t('tpl_empty_sub')));
    empty.addEventListener('click', () => {
      model = { height_cm: 236, sections: [ccSection()] }; picked = true; render();
    });
    grid.appendChild(empty);

    templates.forEach(tpl => {
      const card = h('button', { class: 'tpl-card', type: 'button' },
        h('div', { class: 'tpl-card__prev' }, closetSchematic(ccClone(tpl), { mode: 'mini' })),
        h('span', { class: 'tpl-card__name', dir: 'auto' }, localField(tpl, 'name')),
        h('span', { class: 'tpl-card__sub', dir: 'auto' }, localField(tpl, 'desc')));
      card.addEventListener('click', () => { model = ccClone(tpl); picked = true; render(); });
      grid.appendChild(card);
    });
    host.appendChild(grid);
    host.appendChild(h('div', { class: 'form__actions' },
      h('a', { class: 'btn btn--ghost', href: backHash }, t('cancel'))));
  }

  // ----- editor ------------------------------------------------------------
  function renderEditor() {
    const compose = h('div', { class: 'closet-compose' });

    // closet height
    const heightInput = h('input', {
      class: 'input input--num', type: 'number', min: '50', max: '400',
      inputmode: 'numeric', value: model.height_cm === '' ? '' : String(model.height_cm),
    });
    heightInput.addEventListener('input', () => {
      clearFieldError(heightInput);
      model.height_cm = heightInput.value === '' ? '' : Number(heightInput.value);
      redrawPreview();
    });
    const heightField = h('label', { class: 'field field--num' },
      h('span', { class: 'field__label' }, t('closet_height')), heightInput);
    if (errors.height) setFieldError(heightInput, errors.height);
    compose.appendChild(heightField);

    // live to-scale preview
    previewBody = h('div', { class: 'closet-preview__body' });
    compose.appendChild(h('div', { class: 'closet-preview' },
      h('span', { class: 'closet-preview__label' }, t('preview')), previewBody));
    redrawPreview();

    // sections
    const secWrap = h('div', { class: 'closet-secs' });
    model.sections.forEach((sec, i) => secWrap.appendChild(sectionCard(sec, i)));
    compose.appendChild(secWrap);
    if (errors.sections) compose.appendChild(
      h('p', { class: 'field__error', role: 'alert' }, errors.sections));

    if (model.sections.length < 8) {
      const addSec = h('button', { class: 'btn btn--ghost btn--block', type: 'button' }, '+ ' + t('add_section'));
      addSec.addEventListener('click', () => { errors = {}; model.sections.push(ccSection()); render(); });
      compose.appendChild(addSec);
    }

    const saveBtn = h('button', { class: 'btn btn--primary btn--block', type: 'button' }, t('save_closet'));
    saveBtn.addEventListener('click', () => save(saveBtn));
    compose.appendChild(h('div', { class: 'form__actions' },
      h('a', { class: 'btn btn--ghost', href: backHash }, t('cancel')), saveBtn));
    host.appendChild(compose);

    // Surface the first field error.
    const firstErr = compose.querySelector('.field--invalid .input');
    if (firstErr) focusFieldError(firstErr);
  }

  function sectionCard(sec, i) {
    const card = h('div', { class: 'closet-sec' });
    const del = h('button', { class: 'closet-sec__del', type: 'button' }, t('remove_section'));
    del.disabled = model.sections.length <= 1;
    del.addEventListener('click', () => { errors = {}; model.sections.splice(i, 1); render(); });
    card.appendChild(h('div', { class: 'closet-sec__head' },
      h('span', { class: 'closet-sec__title' }, t('section_n', { n: i + 1 })), del));

    const wInput = h('input', {
      class: 'input input--num', type: 'number', min: '10', max: '300',
      inputmode: 'numeric', value: sec.width_cm === '' ? '' : String(sec.width_cm),
    });
    wInput.addEventListener('input', () => {
      clearFieldError(wInput);
      sec.width_cm = wInput.value === '' ? '' : Number(wInput.value);
      redrawPreview();
    });
    const wField = h('label', { class: 'field field--num' },
      h('span', { class: 'field__label' }, t('width_label')), wInput);
    if (errors['w' + i]) setFieldError(wInput, errors['w' + i]);

    const cornerBox = h('input', { type: 'checkbox' });
    cornerBox.checked = !!sec.corner;
    cornerBox.addEventListener('change', () => { sec.corner = cornerBox.checked; redrawPreview(); });
    card.appendChild(h('div', { class: 'closet-sec__row' }, wField,
      h('label', { class: 'field--corner' }, cornerBox, t('corner_section'))));

    const zonesWrap = h('div', { class: 'closet-zones' });
    sec.zones.forEach((z, j) => zonesWrap.appendChild(zoneRow(sec, i, z, j)));
    card.appendChild(zonesWrap);

    if (sec.zones.length < 20) {
      const addZone = h('button', { class: 'btn btn--ghost btn--sm', type: 'button' }, '+ ' + t('add_zone'));
      addZone.addEventListener('click', () => { errors = {}; sec.zones.push(ccZone('shelf')); render(); });
      card.appendChild(addZone);
    }
    return card;
  }

  function zoneRow(sec, i, z, j) {
    const kindSel = h('select', { class: 'input', 'aria-label': t('add_zone') });
    CLOSET_KINDS.forEach(k => {
      const opt = h('option', { value: k }, t('kind_' + k));
      if (k === z.kind) opt.selected = true;
      kindSel.appendChild(opt);
    });

    const hInput = h('input', {
      class: 'input input--num', type: 'number', min: '1', max: '400', inputmode: 'numeric',
      placeholder: t('height_rest'), 'aria-label': t('height_label'),
      value: z.height_cm != null ? String(z.height_cm) : '',
    });
    hInput.addEventListener('input', () => {
      clearFieldError(hInput);
      z.height_cm = hInput.value === '' ? null : Number(hInput.value);
      redrawPreview();
    });
    const hField = h('label', { class: 'field field--num closet-zone__h' }, hInput);
    if (errors['z' + i + '_' + j]) setFieldError(hInput, errors['z' + i + '_' + j]);

    const labelInput = h('input', {
      class: 'input', type: 'text', dir: 'auto', value: z['label_' + getLang()] || '',
      'aria-label': t('cell_label'), placeholder: t('kind_' + z.kind),
    });
    labelInput.addEventListener('input', () => { z['label_' + getLang()] = labelInput.value; redrawPreview(); });
    kindSel.addEventListener('change', () => {
      z.kind = kindSel.value;
      labelInput.setAttribute('placeholder', t('kind_' + z.kind));
      redrawPreview();
    });

    const del = h('button', { class: 'closet-zone__del', type: 'button', 'aria-label': t('remove_section') }, '×');
    del.disabled = sec.zones.length <= 1;
    del.addEventListener('click', () => { errors = {}; sec.zones.splice(j, 1); render(); });

    return h('div', { class: 'closet-zone' },
      h('div', { class: 'field closet-zone__kind' }, kindSel),
      hField,
      h('div', { class: 'field closet-zone__label' }, labelInput),
      del);
  }

  // ----- validation + save -------------------------------------------------
  function validate() {
    errors = {};
    const hv = Number(model.height_cm);
    if (model.height_cm === '' || !Number.isFinite(hv) || hv < 50 || hv > 400) errors.height = t('err_height_range');
    if (!model.sections.length) errors.sections = t('err_sections_min');
    model.sections.forEach((sec, i) => {
      const wv = Number(sec.width_cm);
      if (sec.width_cm === '' || !Number.isFinite(wv) || wv < 10 || wv > 300) errors['w' + i] = t('err_width_range');
      sec.zones.forEach((z, j) => {
        if (z.height_cm != null) {
          const zv = Number(z.height_cm);
          if (!Number.isFinite(zv) || zv < 1 || zv > 400) errors['z' + i + '_' + j] = t('err_zone_height');
        }
      });
    });
    return Object.keys(errors).length === 0;
  }

  // Items/NFC that dropped or turned-open zones would lose — mirrors the
  // server's degrade rules so the confirm matches what actually happens.
  function affectedCells() {
    const cells = state.cells.filter(c => c.unit_id === unitId);
    const out = [];
    cells.forEach(c => {
      const items = itemsInCell(unitId, c.id).length;
      const tags = state.nfc_tags.filter(tg => tg.target_kind === 'cell' && tg.target_id === c.id).length;
      if (!items && !tags) return;
      let survives = false;
      if (curLayout === 'closet') {
        const sec = model.sections[c.col];
        const z = sec && sec.zones[c.row];
        survives = !!z && z.kind !== 'open';   // dropped OR turned-open => lost
      }
      if (!survives) out.push({ cell: c, items, tags });
    });
    return out;
  }

  async function save(saveBtn) {
    if (!validate()) { render(); return; }

    const affected = affectedCells();
    if (affected.length) {
      const msg = h('div', null, h('p', null, t('closet_loss_pre')));
      const ul = h('ul', { class: 'loss-list' });
      affected.forEach(a => {
        const bits = [];
        if (a.items) bits.push(tCount('items', a.items));
        if (a.tags) bits.push(tCount('nfc_tags', a.tags));
        const li = h('li', null);
        li.appendChild(h('bdi', null, cellLabel(a.cell) || t('cell')));
        li.appendChild(document.createTextNode(' — ' + bits.join(getLang() === 'fa' ? '، ' : ', ')));
        ul.appendChild(li);
      });
      msg.appendChild(ul);
      msg.appendChild(h('p', null, t('closet_loss_post')));
      if (!(await confirmDialog(msg, { confirmLabel: t('save_closet'), danger: true }))) return;
    }

    saveBtn.disabled = true; saveBtn.textContent = t('saving');
    const payload = {
      height_cm: Number(model.height_cm),
      sections: model.sections.map(s => ({
        width_cm: Number(s.width_cm), corner: !!s.corner,
        zones: s.zones.map(z => ({
          kind: z.kind, height_cm: z.height_cm == null ? null : Number(z.height_cm),
          label_en: z.label_en || '', label_fa: z.label_fa || '', label_da: z.label_da || '',
        })),
      })),
    };
    try {
      // One request: PUT /layout converts a 'none' OR 'grid' unit to a closet
      // atomically server-side, so a failure can never strand the unit.
      const res = await apiSend('PUT', 'units/' + unitId + '/layout', payload);
      await loadBootstrap();
      toast((res && res.warnings && res.warnings.length) ? t('closet_warn_saved') : t('toast_saved'));
      location.hash = backHash;
    } catch (e) {
      saveBtn.disabled = false; saveBtn.textContent = t('save_closet');
      toast(t('toast_error'), { kind: 'error' });
    }
  }

  function render() { clear(host); picked ? renderEditor() : renderPicker(); }
  render();
  return wrap;
}

/* ============================================================ *
 *  SCREEN 6 — Borrowed view                                   *
 * ============================================================ */
async function screenBorrowed() {
  const wrap = h('div', { class: 'screen' });
  wrap.appendChild(pageHead(t('nav_borrowed')));
  let borrows = state.borrows_open;
  try {
    const res = await apiGet('borrows?open=1');
    if (res && res.borrows) borrows = res.borrows;
  } catch (_) { /* use cached */ }

  if (!borrows.length) {
    wrap.appendChild(emptyState({
      illo: 'hand', title: t('no_borrows'), sub: t('no_borrows_sub'),
      actionLabel: t('browse_shelves'), actionHref: '#/browse', actionIcon: ICONS.room,
    }));
    return wrap;
  }
  wrap.appendChild(h('p', { class: 'section-title' }, tCount('borrowed_count', borrows.length)));
  const list = h('div', { class: 'borrow-list' });
  borrows.forEach(b => {
    const item = state.itemById.get(b.item_id);
    const name = b.name_en || (item ? itemName(item) : t('untitled'));
    const dueDate = parseDate(b.due_at);
    const overdue = !!dueDate && dueDate < new Date();
    // Calm cards by default; overdue gets the terracotta emphasis (edge rule
    // + paper chip) so the eye lands on what actually needs chasing.
    const row = h('div', { class: 'borrow-card' + (overdue ? ' borrow-card--overdue' : '') });
    row.appendChild(h('a', { class: 'borrow-card__main', href: '#/item/' + b.item_id },
      h('span', { class: 'borrow-card__name', dir: 'auto' }, name),
      overdue ? h('span', { class: 'chip chip--overdue' },
        iconEl(ICONS.alert), h('span', null, t('overdue'))) : null,
      h('span', { class: 'borrow-card__who' }, t('borrowed_by') + ': ',
        h('bdi', null, b.borrowed_by || '—')),
      h('span', { class: 'borrow-card__dates' },
        t('borrowed_on') + ' ' + fmtDate(b.borrowed_at) +
        (b.due_at ? ' · ' + t('due') + ' ' + fmtDate(b.due_at) : '')),
    ));
    row.appendChild(h('button', {
      class: 'btn btn--primary btn--sm', type: 'button',
      onclick: async () => {
        if (item) await returnItem(item);
        else await returnBorrowOnly(b.item_id, name);   // no synthetic stub into state/Fuse
      },
    }, t('return_item')));
    list.appendChild(row);
  });
  wrap.appendChild(list);
  return wrap;
}

/* ============================================================ *
 *  SCREEN 7 — NFC (manager, assign flow, tag deep links)      *
 * ============================================================ */
function shortTagId(id) {
  const s = String(id == null ? '' : id);
  return s.length > 14 ? s.slice(0, 8) + '…' : s;
}

// Localized description of a tag's target ("Drill" / "Living room · Shelf · A2").
// Joined with '·' (direction-neutral) so RTL never has to reorder a chevron.
function nfcTargetText(tag) {
  if (tag.target_kind === 'item') {
    return tag.item ? itemName(tag.item) : t('nfc_target_missing');
  }
  const bits = [];
  if (tag.room) bits.push(localName(tag.room));
  if (tag.unit) bits.push(localName(tag.unit));
  if (tag.target_kind === 'cell') {
    bits.push(tag.cell ? (cellLabel(tag.cell) || t('cell')) : t('nfc_target_missing'));
  }
  return bits.length ? bits.join(' · ') : t('nfc_target_missing');
}

function nfcTargetHash(tag) {
  if (tag.target_kind === 'item') return '#/item/' + tag.target_id;
  if (tag.target_kind === 'cell' && tag.cell) {
    return '#/browse/unit/' + tag.cell.unit_id + '?cell=' + tag.cell.id;
  }
  if (tag.unit) return '#/browse/unit/' + tag.unit.id;
  return '#/nfc';
}

// Inline NFC row used on the item page, the unit header and the cell sheet:
// the assigned tag(s) as chips with an unassign action, or an "assign" link.
// Re-renders itself in place after an unassign so open cell sheets stay open.
function nfcInlineRow(kind, targetId) {
  const host = h('div', { class: 'nfc-inline' });
  function render() {
    clear(host);
    const tags = state.nfc_tags.filter(tg => tg.target_kind === kind && tg.target_id === targetId);
    if (!tags.length) {
      host.appendChild(h('a', {
        class: 'btn btn--ghost btn--sm',
        href: '#/nfc/assign?kind=' + kind + '&target=' + targetId,
      }, iconEl(ICONS.nfc), h('span', null, t('nfc_assign'))));
      return;
    }
    tags.forEach(tag => {
      const chip = h('span', { class: 'chip chip--nfc' },
        iconEl(ICONS.nfc),
        h('bdi', null, tag.name || shortTagId(tag.tag_id)),
        h('span', { class: 'chip__meta' },
          tag.last_scanned_at
            ? t('nfc_last_scanned') + ': ' + fmtDateTime(tag.last_scanned_at)
            : t('nfc_never_scanned')),
      );
      const un = h('button', {
        class: 'btn btn--danger-ghost btn--sm', type: 'button',
        onclick: async () => {
          if (!(await confirmDialog(t('nfc_unassign_confirm'),
            { confirmLabel: t('nfc_unassign'), danger: true }))) return;
          try {
            await apiSend('DELETE', 'nfc/tags/' + tag.id);
            await reloadNfcTags();
            toast(t('nfc_deleted_ok'));
            render();
          } catch (e) { toast(t('toast_error'), { kind: 'error' }); }
        },
      }, t('nfc_unassign'));
      host.appendChild(h('div', { class: 'nfc-inline__row' }, chip, un));
    });
  }
  render();
  return host;
}

// ---- Manager (#/nfc) --------------------------------------------------------
async function screenNfcManager() {
  const wrap = h('div', { class: 'screen' });
  const head = pageHead(t('nfc_tags'), '#/');
  head.appendChild(h('a', { class: 'btn btn--primary btn--sm', href: '#/nfc/assign' },
    iconEl(ICONS.plus), h('span', null, t('nfc_assign'))));
  wrap.appendChild(head);

  // HA down (dev INVENTORY_NO_HA, or supervisor websocket outage): physical
  // scans won't reach us — say so instead of degrading invisibly.
  if (!state.ha_available) {
    wrap.appendChild(h('p', { class: 'assign-note' },
      iconEl(ICONS.alert), ' ', t('nfc_ha_warn')));
  }

  await reloadNfcTags();
  const tags = state.nfc_tags;
  if (!tags.length) {
    wrap.appendChild(emptyState({
      illo: 'nfc', title: t('nfc_empty_title'), sub: t('nfc_empty_sub'),
      actionLabel: t('nfc_assign'), actionHref: '#/nfc/assign', actionIcon: ICONS.plus,
    }));
    return wrap;
  }
  const list = h('div', { class: 'nfclist' });
  tags.forEach(tag => list.appendChild(nfcTagCard(tag)));
  wrap.appendChild(list);
  return wrap;
}

function nfcTagCard(tag) {
  const card = h('div', { class: 'nfccard' + (tag.target_exists ? '' : ' nfccard--broken') });

  // Target glyph: item photo thumb, or a box/grid placeholder.
  if (tag.target_kind === 'item' && tag.item && tag.item.thumb_url) {
    card.appendChild(h('img', {
      class: 'nfccard__thumb', alt: '', loading: 'lazy', decoding: 'async',
      src: new URL(tag.item.thumb_url, document.baseURI).href,
    }));
  } else {
    card.appendChild(h('div', {
      class: 'nfccard__thumb nfccard__thumb--ph', 'aria-hidden': 'true',
    }, iconEl(tag.target_kind === 'item' ? ICONS.box : ICONS.grid)));
  }

  const body = h('div', { class: 'nfccard__body' });
  body.appendChild(h('p', { class: 'nfccard__name', dir: 'auto' },
    h('bdi', null, tag.name || shortTagId(tag.tag_id))));
  if (tag.target_exists) {
    body.appendChild(h('a', {
      class: 'nfccard__target', href: nfcTargetHash(tag), dir: 'auto',
    }, nfcTargetText(tag)));
  } else {
    body.appendChild(h('span', { class: 'chip chip--lost' },
      iconEl(ICONS.alert), h('span', null, t('nfc_target_missing'))));
    body.appendChild(h('span', { class: 'nfccard__meta' }, t('nfc_target_missing_sub')));
  }
  const meta = h('p', { class: 'nfccard__meta' });
  meta.appendChild(h('bdi', { class: 'mono' }, shortTagId(tag.tag_id)));
  meta.appendChild(document.createTextNode(' · ' + (tag.last_scanned_at
    ? t('nfc_last_scanned') + ': ' + fmtDateTime(tag.last_scanned_at)
    : t('nfc_never_scanned'))));
  if (tag.scan_count) {
    meta.appendChild(document.createTextNode(' · ' + tCount('nfc_scans', tag.scan_count)));
  }
  body.appendChild(meta);
  card.appendChild(body);

  card.appendChild(h('div', { class: 'nfccard__actions' },
    h('button', {
      class: 'iconbtn', type: 'button',
      'aria-label': t('nfc_rename'), title: t('nfc_rename'),
      onclick: () => openNfcRename(tag),
    }, iconEl(ICONS.edit)),
    h('button', {
      class: 'iconbtn', type: 'button',
      'aria-label': t('nfc_retarget'), title: t('nfc_retarget'),
      onclick: () => { location.hash = '#/nfc/assign?tag=' + encodeURIComponent(tag.tag_id); },
    }, iconEl(ICONS.grid)),
    h('button', {
      class: 'iconbtn iconbtn--danger', type: 'button',
      'aria-label': t('delete'), title: t('delete'),
      onclick: () => deleteNfcTag(tag),
    }, iconEl(ICONS.trash)),
  ));
  return card;
}

function openNfcRename(tag) {
  const root = $('#modal-root');
  const overlay = h('div', { class: 'modal-overlay' });
  const close = () => { if (overlay.parentNode) root.removeChild(overlay); };
  const form = h('form', { class: 'modal modal--form', role: 'dialog', 'aria-modal': 'true' });
  form.appendChild(h('h2', { class: 'modal__title' }, t('nfc_rename')));
  const nameInput = h('input', { class: 'input', type: 'text', value: tag.name || '',
    placeholder: t('nfc_name_ph'), 'aria-label': t('nfc_name'), dir: 'auto' });
  form.appendChild(h('label', { class: 'field' },
    h('span', { class: 'field__label' }, t('nfc_name')), nameInput));
  form.appendChild(h('div', { class: 'modal__actions' },
    h('button', { class: 'btn btn--ghost', type: 'button', onclick: close }, t('cancel')),
    h('button', { class: 'btn btn--primary', type: 'submit' }, t('save')),
  ));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    close();
    try {
      await apiSend('PATCH', 'nfc/tags/' + tag.id, { name: nameInput.value.trim() });
      await reloadNfcTags();
      toast(t('toast_saved'));
      route();
    } catch (err) { toast(t('toast_error'), { kind: 'error' }); }
  });
  overlay.appendChild(form);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  root.appendChild(overlay);
  nameInput.focus();
}

async function deleteNfcTag(tag) {
  if (!(await confirmDialog(t('nfc_delete_confirm'),
    { confirmLabel: t('delete'), danger: true }))) return;
  try {
    await apiSend('DELETE', 'nfc/tags/' + tag.id);
    await reloadNfcTags();
    toast(t('nfc_deleted_ok'));
    route();
  } catch (e) { toast(t('toast_error'), { kind: 'error' }); }
}

// ---- Assign flow (#/nfc/assign?tag=&kind=&target=) ---------------------------
async function screenNfcAssign(q = {}) {
  const wrap = h('div', { class: 'screen screen--form' });

  // Fresh registry so already-assigned detection / reassign mode are accurate.
  await reloadNfcTags();

  // Launched in context (item page / unit header / cell sheet)? Then Cancel and
  // a successful save both lead back to the target page, not the manager.
  const cameFromTarget = !!(q.target && (q.kind === 'item' || q.kind === 'unit' || q.kind === 'cell'));
  let backTo = '#/nfc';
  if (cameFromTarget) {
    if (q.kind === 'item') backTo = '#/item/' + q.target;
    else if (q.kind === 'unit') backTo = '#/browse/unit/' + q.target;
    else {
      const cell = state.cellById.get(parseInt(q.target, 10));
      backTo = cell ? '#/browse/unit/' + cell.unit_id + '?cell=' + cell.id : '#/nfc';
    }
  }
  wrap.appendChild(pageHead(t('nfc_assign_title'), backTo));

  const model = { tagId: (q.tag || '').trim(), mode: 'item', itemId: null, unitId: null, cellId: null };
  if (q.kind === 'item' && q.target) {
    model.itemId = parseInt(q.target, 10) || null;
  } else if (q.kind === 'unit' && q.target) {
    model.mode = 'place';
    model.unitId = parseInt(q.target, 10) || null;
  } else if (q.kind === 'cell' && q.target) {
    const cell = state.cellById.get(parseInt(q.target, 10));
    if (cell) { model.mode = 'place'; model.unitId = cell.unit_id; model.cellId = cell.id; }
  }
  // Retargeting an already-assigned tag (no explicit target in the URL):
  // preselect its current target so the form opens in a sane state.
  if (!cameFromTarget && model.tagId) {
    const ex0 = state.nfc_tags.find(tg => tg.tag_id === model.tagId);
    if (ex0) {
      if (ex0.target_kind === 'item') { model.mode = 'item'; model.itemId = ex0.target_id; }
      else if (ex0.target_kind === 'unit') { model.mode = 'place'; model.unitId = ex0.target_id; }
      else if (ex0.target_kind === 'cell' && ex0.cell) {
        model.mode = 'place'; model.unitId = ex0.cell.unit_id; model.cellId = ex0.cell.id;
      }
    }
  }

  const form = h('form', { class: 'form' });

  // Step C controls exist early: step A rewrites the submit label on reassign.
  const nameInput = h('input', { class: 'input', type: 'text', dir: 'auto',
    placeholder: t('nfc_name_ph'), 'aria-label': t('nfc_name'), autocomplete: 'off' });
  let nameDirty = false;
  nameInput.addEventListener('input', () => { nameDirty = true; });
  const submitBtn = h('button', { class: 'btn btn--primary', type: 'submit' }, t('nfc_assign'));

  // ---------- Step A: the tag ----------
  form.appendChild(h('h2', { class: 'section-title' }, t('nfc_step_tag')));
  const tagInput = h('input', { class: 'input mono', type: 'text', dir: 'ltr',
    value: model.tagId, placeholder: t('nfc_tag_id_ph'), 'aria-label': t('nfc_tag_id'),
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const assignedNote = h('p', { class: 'assign-note', hidden: true });
  function existingFor(tagId) {
    return state.nfc_tags.find(tg => tg.tag_id === tagId) || null;
  }
  function updateAssignedNote() {
    model.tagId = tagInput.value.trim();
    if (model.tagId) clearFieldError(tagInput);
    const ex = existingFor(model.tagId);
    clear(assignedNote);
    if (ex) {
      assignedNote.hidden = false;
      assignedNote.appendChild(document.createTextNode(t('nfc_already_assigned') + ' '));
      assignedNote.appendChild(h('bdi', null, nfcTargetText(ex)));
      assignedNote.appendChild(document.createTextNode(' — ' + t('nfc_will_move')));
      submitBtn.textContent = t('nfc_reassign');
      if (!nameDirty) nameInput.value = ex.name || '';
    } else {
      assignedNote.hidden = true;
      submitBtn.textContent = t('nfc_assign');
    }
  }
  tagInput.addEventListener('input', updateAssignedNote);
  form.appendChild(h('label', { class: 'field' },
    h('span', { class: 'field__label' }, t('nfc_tag_id')), tagInput));
  form.appendChild(assignedNote);

  // Tag acquisition: HA registry list / Web NFC / QR via the existing scanner.
  const haHost = h('div', { class: 'picklist', hidden: true });
  const nfcHint = h('p', { class: 'hint', hidden: true }, t('nfc_hold_tag'));

  let haLoaded = false;
  async function toggleHaList() {
    haHost.hidden = !haHost.hidden;
    if (haHost.hidden || haLoaded) return;
    haLoaded = true;
    clear(haHost);
    haHost.appendChild(h('p', { class: 'hint' }, t('loading')));
    let res = null;
    try { res = await apiGet('nfc/ha_tags'); } catch (_) {}
    clear(haHost);
    if (!res || !res.ha_available) {
      haHost.appendChild(h('p', { class: 'hint' }, t('nfc_ha_offline')));
      return;
    }
    if (!res.tags || !res.tags.length) {
      haHost.appendChild(h('p', { class: 'hint' }, t('nfc_ha_none')));
      return;
    }
    res.tags.forEach(ht => {
      const assigned = !!existingFor(ht.id);
      haHost.appendChild(h('button', {
        class: 'pickrow', type: 'button',
        onclick: () => { tagInput.value = ht.id; updateAssignedNote(); },
      },
        h('div', { class: 'pickrow__body' },
          h('span', { class: 'pickrow__name' }, h('bdi', null, ht.name || ht.id)),
          h('span', { class: 'pickrow__meta' },
            ht.last_scanned
              ? t('nfc_last_scanned') + ': ' + fmtDateTime(ht.last_scanned)
              : t('nfc_never_scanned')),
        ),
        assigned ? h('span', { class: 'chip' }, t('nfc_assigned_chip')) : null,
      ));
    });
  }

  // Web NFC — Chrome/Android only; the button is hidden when unsupported.
  let ndefCtl = null;
  function stopPhoneNfc() {
    if (ndefCtl) { try { ndefCtl.abort(); } catch (_) {} ndefCtl = null; }
    nfcHint.hidden = true;
  }
  window.addEventListener('hashchange', stopPhoneNfc, { once: true });
  async function scanPhoneNfc() {
    stopPhoneNfc();
    try {
      const reader = new NDEFReader();
      ndefCtl = new AbortController();
      await reader.scan({ signal: ndefCtl.signal });
      nfcHint.hidden = false;
      reader.addEventListener('reading', (ev) => {
        // Companion-app tags carry https://www.home-assistant.io/tag/<uuid>;
        // fall back to the hardware serial for anything else.
        let id = null;
        const records = (ev.message && ev.message.records) || [];
        for (const rec of records) {
          if (rec.recordType === 'url' && rec.data) {
            try {
              const parsed = parseHaTagUrl(new TextDecoder().decode(rec.data));
              if (parsed) { id = parsed; break; }
            } catch (_) {}
          }
        }
        if (!id && ev.serialNumber) id = ev.serialNumber;
        if (!id) return;
        tagInput.value = id;
        updateAssignedNote();
        toast(t('nfc_read_ok'));
        stopPhoneNfc();
      });
      reader.addEventListener('readingerror', () => {
        toast(t('nfc_read_fail'), { kind: 'error' });
      });
    } catch (err) {
      stopPhoneNfc();
      toast(t('nfc_read_fail'), { kind: 'error' });
    }
  }

  async function scanQrForTag() {
    const result = await openScanner();
    if (!result) return;
    const raw = String(result.rawValue == null ? '' : result.rawValue).trim();
    if (!raw) return;
    tagInput.value = parseHaTagUrl(raw) || raw;
    updateAssignedNote();
    toast(t('nfc_read_ok'));
  }

  const srcRow = h('div', { class: 'assign-src' });
  srcRow.appendChild(h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
    onclick: toggleHaList }, iconEl(ICONS.room), h('span', null, t('nfc_pick_ha'))));
  if ('NDEFReader' in window) {
    srcRow.appendChild(h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
      onclick: scanPhoneNfc }, iconEl(ICONS.nfc), h('span', null, t('nfc_scan_phone'))));
  }
  srcRow.appendChild(h('button', { class: 'btn btn--ghost btn--sm', type: 'button',
    onclick: scanQrForTag }, iconEl(ICONS.camera), h('span', null, t('nfc_scan_qr'))));
  form.appendChild(srcRow);
  form.appendChild(nfcHint);
  form.appendChild(haHost);

  // ---------- Step B: the target ----------
  form.appendChild(h('h2', { class: 'section-title' }, t('nfc_step_target')));
  const seg = h('div', { class: 'settings__seg', role: 'group', 'aria-label': t('nfc_step_target') });
  const segItem = h('button', { class: 'seg__btn', type: 'button' }, t('nfc_target_item'));
  const segPlace = h('button', { class: 'seg__btn', type: 'button' }, t('nfc_target_place'));
  seg.appendChild(segItem);
  seg.appendChild(segPlace);
  form.appendChild(seg);

  // Item panel: search-as-you-type over the existing Fuse index.
  // Inline "choose a target" error line — cleared by any target interaction.
  const targetErr = h('p', { class: 'field__error', role: 'alert', hidden: true },
    t('nfc_target_required'));
  const clearTargetErr = () => { targetErr.hidden = true; };

  const itemPanel = h('div', { class: 'assign-panel' });
  const itemSearch = h('input', { class: 'input', type: 'search', dir: 'auto',
    placeholder: t('nfc_search_items_ph'), 'aria-label': t('search'), autocomplete: 'off' });
  const itemResults = h('div', { class: 'picklist' });
  function itemPickRow(it) {
    const row = h('button', {
      class: 'pickrow' + (model.itemId === it.id ? ' is-selected' : ''),
      type: 'button',
      onclick: () => { model.itemId = it.id; clearTargetErr(); renderItemResults(); },
    });
    if (it.thumb_url) {
      row.appendChild(h('img', { class: 'pickrow__thumb', alt: '', loading: 'lazy',
        src: new URL(it.thumb_url, document.baseURI).href }));
    } else {
      row.appendChild(h('div', {
        class: 'pickrow__thumb pickrow__thumb--ph', 'aria-hidden': 'true',
      }, iconEl(ICONS.box)));
    }
    const pl = primaryLocation(it);
    const locTxt = pl && pl.unit
      ? (pl.room ? localName(pl.room) + ' · ' : '') + localName(pl.unit)
      : t('no_location');
    row.appendChild(h('div', { class: 'pickrow__body' },
      h('span', { class: 'pickrow__name', dir: 'auto' }, itemName(it)),
      h('span', { class: 'pickrow__meta', dir: 'auto' }, locTxt)));
    return row;
  }
  function renderItemResults() {
    clear(itemResults);
    const query = itemSearch.value.trim();
    let list;
    if (query.length >= 2) {
      list = runSearch(query).slice(0, 8).map(hit => hit.item);
    } else {
      list = [...state.items]
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
        .slice(0, 6);
    }
    const sel = model.itemId != null ? state.itemById.get(model.itemId) : null;
    if (sel && !list.some(i => i.id === sel.id)) list.unshift(sel);
    list.forEach(it => itemResults.appendChild(itemPickRow(it)));
    if (!list.length) {
      // Never leave the panel silently blank: no items at all -> point at
      // #/add; a query with no hits -> the usual no-matches copy.
      if (!state.items.length) {
        itemResults.appendChild(h('p', { class: 'hint' }, t('nfc_no_items')));
        itemResults.appendChild(h('a', { class: 'btn btn--ghost btn--sm', href: '#/add' },
          iconEl(ICONS.plus), h('span', null, t('add_first_item_cta'))));
      } else {
        itemResults.appendChild(h('p', { class: 'hint' }, t('no_results_title')));
      }
    }
  }
  itemSearch.addEventListener('input', renderItemResults);
  itemPanel.appendChild(itemSearch);
  itemPanel.appendChild(itemResults);

  // Place panel: room -> unit, then an optional DOOR cell on the schematic.
  const placePanel = h('div', { class: 'assign-panel' });
  const roomSel = h('select', { class: 'input', 'aria-label': t('pick_room') });
  const unitSel = h('select', { class: 'input', 'aria-label': t('pick_unit') });
  const cellHost = h('div', { class: 'assign-cells' });

  const presetUnit = model.unitId != null ? state.unitById.get(model.unitId) : null;
  const presetRoomId = presetUnit ? presetUnit.room_id : null;
  roomSel.appendChild(h('option', { value: '' }, '— ' + t('pick_room') + ' —'));
  state.rooms.slice().sort((a, b) => a.sort_order - b.sort_order).forEach(r => {
    roomSel.appendChild(h('option', {
      value: String(r.id), ...(r.id === presetRoomId ? { selected: true } : {}),
    }, localName(r)));
  });

  function renderCellPick() {
    clear(cellHost);
    const unit = model.unitId != null ? state.unitById.get(model.unitId) : null;
    if (!unit || !unit.grid_rows || !unit.grid_cols) { model.cellId = null; return; }
    cellHost.appendChild(h('p', { class: 'hint' }, t('nfc_pick_cell')));
    const byRC = new Map(state.cells.filter(c => c.unit_id === unit.id)
      .map(c => [c.row + ':' + c.col, c]));
    const grid = h('div', {
      class: 'schematic schematic--pick',
      style: `--rows:${unit.grid_rows};--cols:${unit.grid_cols}`,
    });
    for (let r = 0; r < unit.grid_rows; r++) {
      for (let c = 0; c < unit.grid_cols; c++) {
        const cell = byRC.get(r + ':' + c);
        if (!cell || !isDoorCell(cell)) {
          // Open display cubbies (and unsaved slots) are never assignable.
          grid.appendChild(h('div', {
            class: 'schematic__cell schematic__cell--open', 'aria-hidden': 'true',
          }, h('span', { class: 'schematic__label' }, cell ? cellLabel(cell) : '')));
          continue;
        }
        grid.appendChild(h('button', {
          class: 'schematic__cell schematic__cell--door' +
            (model.cellId === cell.id ? ' is-selected' : ''),
          type: 'button',
          'aria-pressed': model.cellId === cell.id ? 'true' : 'false',
          'aria-label': cellLabel(cell) || (r + 1) + '×' + (c + 1),
          onclick: () => {
            model.cellId = model.cellId === cell.id ? null : cell.id;
            renderCellPick();
          },
        }, h('span', { class: 'schematic__label' }, cellLabel(cell) || '')));
      }
    }
    cellHost.appendChild(grid);
    const selCell = model.cellId != null ? state.cellById.get(model.cellId) : null;
    cellHost.appendChild(h('p', { class: 'hint hint--count' },
      selCell ? (cellLabel(selCell) || t('cell')) : t('nfc_whole_unit')));
  }

  function fillUnits() {
    clear(unitSel);
    unitSel.appendChild(h('option', { value: '' }, '— ' + t('pick_unit') + ' —'));
    const rid = parseInt(roomSel.value, 10);
    state.units.filter(u => u.room_id === rid)
      .sort((a, b) => a.sort_order - b.sort_order)
      .forEach(u => {
        unitSel.appendChild(h('option', {
          value: String(u.id), ...(model.unitId === u.id ? { selected: true } : {}),
        }, localName(u)));
      });
    const uid = parseInt(unitSel.value, 10);
    model.unitId = uid || null;
    if (model.cellId != null) {
      const cell = state.cellById.get(model.cellId);
      if (!cell || cell.unit_id !== model.unitId) model.cellId = null;
    }
    renderCellPick();
  }
  roomSel.addEventListener('change', () => { model.unitId = null; model.cellId = null; clearTargetErr(); fillUnits(); });
  unitSel.addEventListener('change', () => {
    model.unitId = parseInt(unitSel.value, 10) || null;
    model.cellId = null;
    clearTargetErr();
    renderCellPick();
  });

  placePanel.appendChild(h('label', { class: 'field' },
    h('span', { class: 'field__label' }, t('pick_room')), roomSel));
  placePanel.appendChild(h('label', { class: 'field' },
    h('span', { class: 'field__label' }, t('pick_unit')), unitSel));
  placePanel.appendChild(cellHost);

  function setMode(m) {
    model.mode = m;
    segItem.classList.toggle('is-active', m === 'item');
    segPlace.classList.toggle('is-active', m === 'place');
    itemPanel.hidden = m !== 'item';
    placePanel.hidden = m !== 'place';
  }
  segItem.addEventListener('click', () => { clearTargetErr(); setMode('item'); });
  segPlace.addEventListener('click', () => { clearTargetErr(); setMode('place'); });

  form.appendChild(itemPanel);
  form.appendChild(placePanel);
  form.appendChild(targetErr);

  // ---------- Step C: optional friendly name + submit ----------
  form.appendChild(h('h2', { class: 'section-title' }, t('nfc_step_name')));
  form.appendChild(h('label', { class: 'field' },
    h('span', { class: 'field__label' }, t('nfc_name')), nameInput));
  form.appendChild(h('div', { class: 'form__actions' },
    h('a', { class: 'btn btn--ghost', href: backTo }, t('cancel')),
    submitBtn));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tagId = tagInput.value.trim();
    if (!tagId) {
      setFieldError(tagInput, t('nfc_tag_required'));
      toast(t('nfc_tag_required'), { kind: 'error' });
      focusFieldError(tagInput);
      return;
    }
    let target_kind;
    let target_id;
    if (model.mode === 'item') { target_kind = 'item'; target_id = model.itemId; }
    else if (model.cellId != null) { target_kind = 'cell'; target_id = model.cellId; }
    else { target_kind = 'unit'; target_id = model.unitId; }
    if (target_id == null) {
      targetErr.hidden = false;
      toast(t('nfc_target_required'), { kind: 'error' });
      try {
        targetErr.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
      } catch (_) {}
      return;
    }

    const name = nameInput.value.trim();
    const prevLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = t('saving');
    try {
      let saved = false;
      let reassigned = false;
      const ex = existingFor(tagId);
      if (ex) {
        await apiSend('PATCH', 'nfc/tags/' + ex.id, { name, target_kind, target_id });
        saved = true; reassigned = true;
      } else {
        const res = await apiSendRaw('POST', 'nfc/tags',
          { tag_id: tagId, name, target_kind, target_id });
        if (res.ok) {
          saved = true;
        } else if (res.status === 409 && res.data && res.data.existing) {
          // Assigned since our snapshot: show the current owner, offer reassign.
          const msg = h('span', null,
            t('nfc_already_assigned') + ' ',
            h('bdi', null, nfcTargetText(res.data.existing)),
            ' — ' + t('nfc_reassign_q'));
          if (await confirmDialog(msg, { confirmLabel: t('nfc_reassign') })) {
            await apiSend('PATCH', 'nfc/tags/' + res.data.existing.id,
              { name, target_kind, target_id });
            saved = true; reassigned = true;
          }
        } else {
          throw new Error((res.data && res.data.error) || ('HTTP ' + res.status));
        }
      }
      if (!saved) {
        submitBtn.disabled = false;
        submitBtn.textContent = prevLabel;
        return;
      }
      await reloadNfcTags();
      toast(reassigned ? t('nfc_reassigned_ok') : t('nfc_assigned_ok'));
      if (cameFromTarget) {
        if (target_kind === 'item') nav('#/item/' + target_id);
        else if (target_kind === 'cell') nav('#/browse/unit/' + model.unitId + '?cell=' + target_id);
        else nav('#/browse/unit/' + target_id);
      } else {
        nav('#/nfc');
      }
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = prevLabel;
      toast(t('toast_error'), { kind: 'error' });
    }
  });

  // Initial fills + state.
  renderItemResults();
  fillUnits();
  setMode(model.mode);
  updateAssignedNote();

  wrap.appendChild(form);
  return wrap;
}

// ---- #/tag/<tag_id> deep link ------------------------------------------------
// NFC tags written with a URL land here. Resolve and redirect (location.replace
// keeps Back clean): item -> item page, place -> unit browse with the cell
// highlighted, unassigned/orphaned -> assign flow prefilled.
function screenTagResolve(tagId) {
  const wrap = h('div', { class: 'screen' });
  wrap.appendChild(pageHead(t('nfc_tag')));
  wrap.appendChild(h('p', { class: 'hint' }, t('nfc_resolving')));
  (async () => {
    try {
      const res = await apiGet('nfc/resolve/' + encodeURIComponent(tagId));
      if (res && res.assigned && res.tag && res.tag.target_exists) {
        location.replace(nfcTargetHash(res.tag));
        return;
      }
    } catch (_) {
      toast(t('toast_offline'), { kind: 'error' });
    }
    location.replace('#/nfc/assign?tag=' + encodeURIComponent(tagId));
  })();
  return wrap;
}

/* ============================================================ *
 *  Shared page header                                         *
 * ============================================================ */
function pageHead(title, backHash) {
  const head = h('div', { class: 'pagehead' });
  if (backHash) {
    head.appendChild(h('a', { class: 'iconbtn pagehead__back', href: backHash, 'aria-label': t('back') },
      iconEl(ICONS.back)));
  }
  head.appendChild(h('h1', { class: 'pagehead__title' }, title));
  return head;
}

/* ============================================================ *
 *  Data loading + cache mutation                              *
 * ============================================================ */
async function loadBootstrap() {
  const data = await apiGet('bootstrap');
  state.user = data.user || '';
  state.rooms = data.rooms || [];
  state.units = data.units || [];
  state.cells = data.cells || [];
  state.items = (data.items || []).map(normItem);
  state.borrows_open = data.borrows_open || [];
  state.nfc_tags = data.nfc_tags || [];
  state.ha_available = !!data.ha_available;
  rebuildIndexes();
  buildFuse();
  buildPlacesFuse();
  state.loaded = true;
}

function normItem(it) {
  // Ensure tags is an array (server sends array per ADDENDA §5, but be defensive).
  if (typeof it.tags === 'string') {
    try { it.tags = JSON.parse(it.tags); } catch (_) { it.tags = []; }
  }
  if (!Array.isArray(it.tags)) it.tags = [];
  if (!Array.isArray(it.locations)) it.locations = [];
  return it;
}

function upsertItem(item) {
  if (!item || item.id == null) return;
  normItem(item);
  const idx = state.items.findIndex(i => i.id === item.id);
  if (idx >= 0) state.items[idx] = item; else state.items.push(item);
  state.itemById.set(item.id, item);
  buildFuse();
}

async function refreshItem(id) {
  try { const it = await apiGet('items/' + id); upsertItem(it); } catch (_) {}
}
async function reloadBorrows() {
  try { const res = await apiGet('borrows?open=1'); if (res) state.borrows_open = res.borrows || []; }
  catch (_) {}
}
async function reloadNfcTags() {
  try { const res = await apiGet('nfc/tags'); if (res) state.nfc_tags = res.tags || []; }
  catch (_) { /* keep cached copy */ }
}

// Navigate to a hash, re-routing explicitly when the hash is already current
// (setting an identical location.hash fires no hashchange event).
function nav(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/* ============================================================ *
 *  Router                                                     *
 * ============================================================ */
function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function parseHash() {
  // Strip the query part first so it never leaks into the path segments.
  let raw = location.hash.replace(/^#/, '') || '/';
  const qIdx = raw.indexOf('?');
  if (qIdx >= 0) raw = raw.slice(0, qIdx);
  const parts = raw.split('/').filter(Boolean); // e.g. ['item','42']
  return parts;
}

// Parse the query part of the hash (e.g. #/add?unit=1&cell=12 -> {unit:'1', cell:'12'}).
function parseHashQuery() {
  const idx = location.hash.indexOf('?');
  if (idx < 0) return {};
  const out = {};
  new URLSearchParams(location.hash.slice(idx + 1)).forEach((v, k) => { out[k] = v; });
  return out;
}

async function route() {
  if (!state.loaded) return;
  // Cancel any pending debounced search so it can't fire against detached nodes.
  if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }
  const parts = parseHash();
  setActiveTab(location.hash);
  // mount fresh content
  const render = (node) => {
    clear(viewRoot);
    viewRoot.appendChild(node);
    // focus management on route change (a11y)
    viewRoot.focus({ preventScroll: false });
    viewRoot.scrollTop = 0;
    window.scrollTo(0, 0);
  };

  // synchronous screens
  if (parts.length === 0) return render(screenHome('home'));
  const [a, b, c] = parts;

  if (a === 'search') return render(screenHome('search'));
  if (a === 'objects') return render(screenObjects(parseHashQuery()));

  if (a === 'browse') {
    if (!b) return render(screenBrowse());
    if (b === 'room' && c) return render(screenBrowseRoom(parseInt(c, 10)));
    if (b === 'unit' && c) {
      // ?cell=<id> (search hits, NFC location links) highlights + auto-opens it.
      const q = parseHashQuery();
      return render(screenBrowseUnit(parseInt(c, 10), {
        highlightCellId: q.cell ? parseInt(q.cell, 10) : null,
      }));
    }
    return render(screenBrowse());
  }
  if (a === 'add') {
    const q = parseHashQuery();
    const preselect = (q.unit || q.barcode)
      ? {
          unit_id: q.unit ? parseInt(q.unit, 10) : null,
          cell_id: q.cell != null ? parseInt(q.cell, 10) : null,
          barcode: q.barcode || null,
        }
      : null;
    return render(await screenAddEdit(null, preselect));
  }
  if (a === 'borrowed') return render(await screenBorrowed());

  if (a === 'item' && b) {
    const id = parseInt(b, 10);
    if (c === 'edit') return render(await screenAddEdit(id));
    // ?undo=<borrow_id> (NFC scan notifications) shows an inline undo banner.
    const q = parseHashQuery();
    return render(await screenItem(id, {
      undoBorrowId: q.undo ? parseInt(q.undo, 10) : null,
    }));
  }
  if (a === 'unit' && b && c === 'grid') {
    const q = parseHashQuery();
    if (q.cell) {
      // Compat shim: older NFC notifications linked cell tags to
      // #/unit/<id>/grid?cell= (the server now sends #/browse/unit/<id>?cell=).
      // Hand them to the browse view, which owns highlight/auto-open.
      location.replace('#/browse/unit/' + b + '?cell=' + encodeURIComponent(q.cell));
      return;
    }
    return render(await screenGridEditor(parseInt(b, 10)));
  }
  if (a === 'unit' && b && c === 'closet') {
    return render(await screenClosetEditor(parseInt(b, 10)));
  }

  if (a === 'nfc') {
    if (b === 'assign') return render(await screenNfcAssign(parseHashQuery()));
    return render(await screenNfcManager());
  }
  if (a === 'tag' && b) {
    let tid = b;
    try { tid = decodeURIComponent(b); } catch (_) {}
    return render(screenTagResolve(tid));
  }

  // fallback
  location.hash = '#/';
}

/* ============================================================ *
 *  Bootstrap                                                  *
 * ============================================================ */
async function init() {
  // theme + language first (before any render)
  applyTheme(currentTheme());
  setLang(getLang());

  renderShell();

  // loading skeleton
  clear(viewRoot);
  viewRoot.appendChild(h('div', { class: 'screen' },
    h('section', { class: 'hero' }, h('div', { class: 'searchbox searchbox--skel skel' })),
    skeletonCards(5)));

  try {
    await loadBootstrap();
  } catch (e) {
    clear(viewRoot);
    viewRoot.appendChild(emptyState({
      icon: ICONS.alert, title: t('toast_offline'), sub: '',
      actionLabel: t('retry'), action: () => init(),
    }));
    return;
  }

  window.addEventListener('hashchange', route);
  if (!location.hash) location.hash = '#/';
  route();
}

init();
