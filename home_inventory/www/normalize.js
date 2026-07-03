// normalize.js — shared text normalizer for search (BUILD_SPEC §7).
// IDENTICAL logic to normalize.py (server-side stored `search` blob).
// Order is load-bearing:
//   1) lowercase + NFD-strip combining marks
//   2) Danish digraphs (æ/ø/å -> ae/oe/aa)
//   3) Persian harakat/tatweel drop + confusable folding
//   4) digit folding (Arabic-Indic + Persian -> ASCII)
//   5) ZWNJ -> space, collapse whitespace  (SEARCH COPY ONLY — never mutate stored/displayed text)

const FA_MAP = {
  'ك': 'ک',                          // Arabic Kaf  -> Persian Keheh
  'ي': 'ی', 'ى': 'ی',               // Arabic Yeh / Alef Maksura -> Persian Yeh
  'آ': 'ا', 'أ': 'ا', 'إ': 'ا', 'ٱ': 'ا', // Alef variants -> bare Alef
  'ؤ': 'و',                          // Waw with hamza -> Waw
  'ة': 'ه',                          // Teh Marbuta -> Heh
};

function foldDigits(s) {
  return s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))   // Arabic-Indic
          .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));  // Persian
}

export function normalize(input) {
  if (input == null) return '';
  let s = String(input);
  // a) lowercase + strip Latin diacritics (é->e, ñ->n)
  s = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // b) Danish digraphs (users type ae/oe/aa)
  s = s.replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa');
  // c) Persian: drop harakat (U+064B-065F), superscript alef (U+0670), tatweel (U+0640); map confusables
  s = s.replace(/[ً-ٰٟ]/g, '').replace(/ـ/g, '');
  s = s.replace(/[كيىآأإٱؤة]/g, c => FA_MAP[c] || c);
  // d) digits
  s = foldDigits(s);
  // e) ZWNJ (U+200C) -> space, collapse whitespace  (SEARCH COPY ONLY)
  s = s.replace(/‌/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

export default normalize;
