"""
normalize.py — server-side text normalization for the stored search blob.

Line-for-line port of www/normalize.js (BUILD_SPEC §7). The two MUST stay
identical so that what the server stores in items.search matches what the
client's Fuse.js index searches against.

Order is load-bearing:
  a) lowercase + NFD-strip combining marks (Latin diacritics: e -> e, n -> n)
  b) Danish digraphs (ae / oe / aa)
  c) Persian: drop harakat/superscript-alef/tatweel, map confusables
  d) digit folding (Arabic-Indic + Persian -> ASCII)
  e) ZWNJ -> space, collapse whitespace  (SEARCH COPY ONLY)

ZWNJ is stripped only in the search copy — never in stored/displayed text.
"""

import re
import unicodedata

# Persian confusable map: Arabic forms -> canonical Persian forms.
FA_MAP = {
    "ك": "ک",  # Arabic Kaf        -> Persian Keheh   (ك -> ک)
    "ي": "ی",  # Arabic Yeh        -> Persian Yeh      (ي -> ی)
    "ى": "ی",  # Alef Maksura      -> Persian Yeh      (ى -> ی)
    "آ": "ا",  # Alef with madda   -> bare Alef        (آ -> ا)
    "أ": "ا",  # Alef with hamza   -> bare Alef        (أ -> ا)
    "إ": "ا",  # Alef w/ hamza blw -> bare Alef        (إ -> ا)
    "ٱ": "ا",  # Alef wasla        -> bare Alef        (ٱ -> ا)
    "ؤ": "و",  # Waw with hamza    -> Waw              (ؤ -> و)
    "ة": "ه",  # Teh Marbuta       -> Heh              (ة -> ه)
}

# Characters covered by FA_MAP, for a single-pass translate.
_FA_PATTERN = re.compile("[" + "".join(FA_MAP.keys()) + "]")

# Persian harakat (U+064B–U+065F) + superscript alef (U+0670).
_HARAKAT = re.compile("[ً-ٰٟ]")
# Tatweel / kashida (U+0640).
_TATWEEL = re.compile("ـ")
# Latin combining diacritics after NFD (U+0300–U+036F).
_LATIN_COMBINING = re.compile("[̀-ͯ]")
# Whitespace run collapse.
_WS = re.compile(r"\s+")


def _fold_digits(s: str) -> str:
    """Fold Arabic-Indic (U+0660–9) and Persian (U+06F0–9) digits to ASCII."""
    out = []
    for ch in s:
        cp = ord(ch)
        if 0x0660 <= cp <= 0x0669:      # Arabic-Indic
            out.append(str(cp - 0x0660))
        elif 0x06F0 <= cp <= 0x06F9:    # Persian (extended Arabic-Indic)
            out.append(str(cp - 0x06F0))
        else:
            out.append(ch)
    return "".join(out)


def normalize(value) -> str:
    """Normalize a string for search. Mirrors normalize.js exactly."""
    if value is None:
        return ""
    s = str(value)

    # a) lowercase + strip Latin diacritics (é -> e, ñ -> n)
    s = s.lower()
    s = unicodedata.normalize("NFD", s)
    s = _LATIN_COMBINING.sub("", s)

    # b) Danish digraphs (users type ae/oe/aa)
    s = s.replace("æ", "ae").replace("ø", "oe").replace("å", "aa")

    # c) Persian: drop harakat + superscript alef + tatweel; map confusables
    s = _HARAKAT.sub("", s)
    s = _TATWEEL.sub("", s)
    s = _FA_PATTERN.sub(lambda m: FA_MAP.get(m.group(0), m.group(0)), s)

    # d) digits
    s = _fold_digits(s)

    # e) ZWNJ (U+200C) -> space, collapse whitespace  (SEARCH COPY ONLY)
    s = s.replace("‌", " ")
    s = _WS.sub(" ", s).strip()
    return s
