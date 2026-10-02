// Import official sixth-grade Islamic education PDFs into the searchable curriculum.
//
//   node scripts/import-deni-books.mjs [--out-dir <path>] [--only <id,id>] [--force] [--no-glyphs]
//
// --out-dir redirects every write (pdf-books/, outlines/, pdf-index.json) to another
// directory, so several agents can run the importer in parallel without touching the
// shared library files. Reading pdf-sources/ and the existing pdf-index.json is enough
// to rebuild a whole book from scratch, so an --out-dir run is always a full re-extract.
//
// Text extraction is geometric instead of stream-ordered: rows are rebuilt from item
// baselines, each row is ordered right-to-left when it is Arabic and left-to-right when
// it is Latin or numeric, super/subscripts are re-attached to their base glyph,
// fraction rules keep the glyphs above and below them, painted-over ghost layers (the
// same line drawn several times) are dropped, digits whose ToUnicode entry is provably
// broken are rebuilt from the glyph codes, and glyph runs that come from a font without
// a usable ToUnicode are marked as corrupt instead of being published as fake Latin.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY = path.join(ROOT, 'curriculum-library');
const SOURCES = path.join(LIBRARY, 'pdf-sources');
const SOURCE_INDEX_FILE = path.join(LIBRARY, 'pdf-index.json');

const CLI = parseArgs(process.argv.slice(2));
const SANDBOX = Boolean(CLI['out-dir']);
const TARGET = SANDBOX ? path.resolve(ROOT, String(CLI['out-dir'])) : LIBRARY;
const BOOKS_DIR = path.join(TARGET, 'pdf-books');
const OUTLINES_DIR = path.join(TARGET, 'outlines');
const INDEX_FILE = path.join(TARGET, 'pdf-index.json');
const ONLY = CLI.only ? new Set(String(CLI.only).split(',').map((value) => value.trim()).filter(Boolean)) : null;
const FORCE = Boolean(CLI.force);
const USE_GLYPHS = CLI['no-glyphs'] !== true;
const REBUILD = FORCE || SANDBOX || Boolean(ONLY);

const CJK = /[\u3400-\u9fff]/u;
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;
// Arabic script letters only: an Arabic-Indic digit is a neutral glyph and must not be
// treated as an Arabic word that interrupts a run of Latin noise
const ARABIC_SCRIPT = /[\u0600-\u0655\u066E-\u06D3\u06EE\u06FA-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/u;
const LATIN = /[A-Za-z]/u;
const LETTER = /\p{L}/u;
const DIGIT = /[0-9\u0660-\u0669\u06F0-\u06F9]/u;
const FOLIO = /^\d{1,4}$/u;
const PAGE_TYPES = ['divider', 'lesson_content', 'parallel_text', 'boxed_recap', 'matching', 'exercises', 'glossary', 'contents'];
const OPS_BY_CODE = new Map(Object.entries(pdfjs.OPS).map(([name, code]) => [code, name]));
const SHOW_OPS = new Set(['showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText']);
const SUPERSCRIPT = { 0: '\u2070', 1: '\u00B9', 2: '\u00B2', 3: '\u00B3', 4: '\u2074', 5: '\u2075', 6: '\u2076', 7: '\u2077', 8: '\u2078', 9: '\u2079' };
const REPLACEMENT = '\uFFFD';

const BOOKS = [
  {
    file: 'كتاب مباحث القراءات القرانية السادس الاعدادي.pdf',
    id: 'quran-readings-deni-sixth',
    title: 'مباحث القراءات القرآنية — كتاب الطالب للصف السادس الإعدادي الإسلامي',
    subject: 'القرآن وعلومه — مباحث القراءات',
    edition: '1445هـ — 2023م', year: 2023,
    url: 'http://taleemdeny.edu.iq/images/books/%20مباحث القراءات القرانية الصف السادس.pdf',
    expectedPages: 63,
  },
  {
    file: 'كتاب الفقه السادس الاعدادي.pdf',
    id: 'fiqh-shafii-deni-sixth',
    title: 'الفقه الإسلامي — كتاب الطالب — الصف السادس الإعدادي الإسلامي (الشافعي)',
    subject: 'الفقه الشافعي',
    edition: 'السادس الإعدادي الإسلامي', year: null,
    url: 'http://taleemdeny.edu.iq/images/books/%20الفقه الشافعي الصف السادس.pdf',
    expectedPages: 106,
  },
  {
    file: 'كتاب الفقه الحنفي السادس الاعدادي.pdf',
    id: 'fiqh-hanafi-deni-sixth',
    title: 'الحدود والجنايات والأيمان والنذر في الفقه الحنفي — الصف السادس',
    subject: 'الفقه الحنفي (إضافي)',
    edition: 'الطبعة الأولى 1436هـ — 2015م', year: 2015,
    url: 'http://taleemdeny.edu.iq/images/books/%20الفقه الحنفي الصف السادس.pdf',
    expectedPages: 45,
  },
  {
    file: 'كتاب التاريخ والسيرة السادس الاعدادي.pdf',
    id: 'history-deni-sixth',
    title: 'تاريخ العالم الإسلامي الحديث والمعاصر — الصف السادس الإعدادي الإسلامي',
    subject: 'التاريخ والسيرة (التعليم الديني)',
    edition: 'الطبعة الثالثة 1442هـ — 2020م', year: 2020,
    url: 'http://taleemdeny.edu.iq/images/books/%20تاريخ العالم الاسلامي الصف السادس.pdf',
    expectedPages: 140,
  },
  {
    file: 'كتاب النحو والتطبيق السادس الاعدادي.pdf',
    id: 'arabic-grammar-deni-sixth',
    title: 'النحو الواضح في قواعد اللغة العربية — الصف السادس الإعدادي الإسلامي',
    subject: 'النحو والتطبيق (التعليم الديني)',
    edition: 'الطبعة الرابعة 1442هـ — 2020م', year: 2020,
    url: 'http://taleemdeny.edu.iq/images/books/%20النحو الواضح الصف السادس.pdf',
    expectedPages: 105,
  },
  {
    file: 'كتاب البلاغة السادس الاعدادي.pdf',
    id: 'balagha-deni-sixth',
    title: 'البلاغة العربية — كتاب الطالب للصف السادس الإعدادي الإسلامي',
    subject: 'البلاغة (التعليم الديني)',
    edition: '1445هـ — 2023م', year: 2023,
    url: 'http://taleemdeny.edu.iq/images/books/%20البلاغة العربية الصف السادس.pdf',
    expectedPages: 59,
  },
  {
    file: 'كتاب اللغة الانكليزية السادس الاعدادي.pdf',
    id: 'english-deni-sixth',
    title: "English Course for Iraqi Islamic Schools — Student's Book (6)",
    subject: 'اللغة الإنكليزية (التعليم الديني)',
    edition: '2015 Edition', year: 2015,
    url: 'http://taleemdeny.edu.iq/images/books/%20اللغة الانكليزية الصف السادس.pdf',
    expectedPages: 129,
  },
  {
    file: 'كتاب الرياضيات السادس الاعدادي.pdf',
    id: 'mathematics-deni-sixth',
    title: 'الرياضيات للصف السادس الثانوي — ديوان الوقف السني',
    subject: 'الرياضيات (التعليم الديني)',
    edition: 'الطبعة السابعة 2019م', year: 2019,
    url: 'http://taleemdeny.edu.iq/images/books/%20الرياضيات الصف السادس.pdf',
    expectedPages: 80,
  },
  {
    file: 'كتاب الحديث السادس الاعدادي.pdf',
    id: 'hadith-deni-sixth',
    title: 'الحديث النبوي الشريف وعلومه — كتاب الطالب للصف السادس الإعدادي الإسلامي',
    subject: 'الحديث (التعليم الديني)',
    edition: 'الصف السادس الإعدادي الإسلامي', year: null,
    url: 'http://taleemdeny.edu.iq/images/books/%20الحديث الصف السادس.pdf',
    expectedPages: 159,
  },
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function clean(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
}

function compactText(value) {
  return String(value || '').replace(/\s+/gu, '').replace(/[\u064B-\u0652\u0670\u0653-\u065F\u0640]/gu, '');
}

// ------------------------------------------------------------------ glyph layer

function flattenGlyphArgs(raw) {
  const parts = (Array.isArray(raw) && Array.isArray(raw[0])) ? raw[0] : raw;
  const out = [];
  if (!Array.isArray(parts)) return out;
  for (const part of parts) {
    if (typeof part === 'string') {
      for (const ch of part) out.push({ ch, code: -1 });
    } else if (Array.isArray(part)) {
      for (const glyph of part) if (glyph && typeof glyph.unicode === 'string') out.push({ ch: glyph.unicode, code: glyph.originalCharCode });
    } else if (part && typeof part.unicode === 'string') {
      out.push({ ch: part.unicode, code: part.originalCharCode });
    }
  }
  return out;
}

/**
 * Read the raw glyph stream of a page from the operator list. getTextContent() items
 * carry no character codes, so this is the only place where the font mapping
 * (character code → unicode) can be inspected and corrected.
 */
async function glyphStreamOf(page) {
  const out = { ok: false, glyphs: [], digits: new Map() };
  let list;
  try { list = await page.getOperatorList(); } catch { return out; }
  const fns = list.fnArray;
  const args = list.argsArray;
  let font = '';
  for (let i = 0; i < fns.length; i += 1) {
    const name = OPS_BY_CODE.get(fns[i]) || '';
    if (name === 'setFont') { font = String(args[i][0] || ''); continue; }
    if (!SHOW_OPS.has(name)) continue;
    const glyphs = flattenGlyphArgs(args[i]).filter((glyph) => !/^\s+$/u.test(glyph.ch));
    if (!glyphs.length) continue;
    for (const glyph of glyphs) out.glyphs.push({ ...glyph, font });
    const digits = out.digits.get(font) || new Map();
    for (const glyph of glyphs) {
      if (typeof glyph.code !== 'number' || glyph.code < 0) continue;
      if (!/^[0-9]$/u.test(glyph.ch) || digits.has(glyph.code)) continue;
      digits.set(glyph.code, glyph.ch);
    }
    out.digits.set(font, digits);
  }
  out.ok = out.glyphs.length > 0;
  return out;
}

/**
 * These textbooks ship fonts whose ToUnicode CMap hands out an ascending run of Latin
 * digits whose first code repeats the second one, so the printed zero (٠) is published
 * as "1" (٧٢٠ → 721). The repair is not a guess: a digit run has to be contiguous, so
 * the duplicated head is provably the zero and every other code in the run is sound.
 */
function digitRunDefects(digits) {
  const codes = [...digits.keys()].sort((a, b) => a - b);
  const defects = [];
  let start = 0;
  while (start < codes.length) {
    let end = start;
    while (end + 1 < codes.length && codes[end + 1] === codes[end] + 1) end += 1;
    const run = codes.slice(start, end + 1).map((code) => Number(digits.get(code)));
    if (run.length >= 4 && run[0] === 1 && run[1] === 1 && run.slice(1).every((value, k) => value === run[1] + k)) {
      defects.push({ code: codes[start], brokenValue: '1', fixedValue: '0' });
    }
    start = end + 1;
  }
  return defects;
}

/**
 * Rewrite the digits of one item from its glyph codes. pdf.js hands back the items in logical
 * order and the glyph stream in visual order, so the two are never aligned position by
 * position; instead every pure-number item looks for the run of glyphs that produces exactly
 * its own digits (after the repaired font mapping is applied) in a window around its expected
 * spot. Nothing is rewritten unless the glyphs really spell that number, and a digit is only
 * changed when the glyph behind it is the one whose mapping is provably broken.
 */
function repairItemDigits(items, stream, defectsByFont) {
  const stats = { items: 0, glyphs: 0 };
  if (!stream.ok || !defectsByFont.size) return { items, stats };
  const glyphs = stream.glyphs;
  const fixFor = (glyph) => {
    const defects = defectsByFont.get(glyph.font);
    if (!defects) return glyph.ch;
    for (const defect of defects) if (defect.code === glyph.code) return defect.fixedValue;
    return glyph.ch;
  };
  const originalChars = glyphs.map((glyph) => glyph.ch);
  const out = [];
  let cursor = 0;
  for (const item of items) {
    const raw = String(item && item.str || '');
    if (!raw.replace(/\s+/gu, '')) { out.push(item); continue; }
    cursor += raw.replace(/\s+/gu, '').length;
    if (!/^[0-9٠-٩.,]+$/u.test(raw)) { out.push(item); continue; }
    const size = raw.length;
    if (size < 2) { out.push(item); continue; }
    const variants = new Set();
    const from = Math.max(0, cursor - size - 32);
    const to = Math.min(originalChars.length - size, cursor + 32);
    for (let start = from; start <= to; start += 1) {
      if (originalChars.slice(start, start + size).join('') !== raw) continue;
      const chars = [...raw];
      for (let k = 0; k < size; k += 1) {
        const glyph = glyphs[start + k];
        const value = fixFor(glyph);
        if (value !== glyph.ch) chars[k] = value;
      }
      variants.add(chars.join(''));
    }
    // one reading only: when two glyph runs spell the same number and disagree about the
    // broken digit, the item is left alone instead of guessed
    if (variants.size !== 1) { out.push(item); continue; }
    const repaired = [...variants][0];
    if (repaired === raw) { out.push(item); continue; }
    stats.items += 1;
    stats.glyphs += 1;
    out.push({ ...item, str: repaired });
  }
  return { items: out, stats };
}

/**
 * A run of Latin glyphs from a font that never emits a single Arabic character, sitting on a
 * line that is otherwise Arabic and not interrupted by Arabic text, is the classic signature
 * of a font with no usable ToUnicode: pdf.js falls back to "glyph index as character" and a
 * verse comes out as "ÛÚÙØ×ÖÕÔÓÒÑÐ" between the brackets that are really ﴿ ﴾. Publishing
 * that as scripture is worse than admitting the text is corrupt, so the run is replaced by an
 * explicit replacement character.
 *
 * The test only fires on a bracketed pair from one decorative font or on letters that no
 * Arabic textbook writes, so real Latin text and single math variables are never touched.
 */
/** A run item that really reads as text: it holds a word of three letters with a vowel. */
function looksLikeWord(text) {
  return String(text || '').split(/\s+/u).some((word) => /^[A-Za-z]{3,}$/u.test(word)
    && /[aeiouyAEIOUY]/u.test(word) && !/(.)\1\1/u.test(word));
}

function markUntrustedRuns(items, stream, pageHasArabic) {
  const stats = { runs: 0 };
  if (!stream.ok || !pageHasArabic || !items.length) return stats;
  const arabicFonts = new Set();
  for (const glyph of stream.glyphs) {
    if (ARABIC_SCRIPT.test(glyph.ch)) arabicFonts.add(glyph.font);
  }
  const fontUse = new Map();
  for (const item of items) {
    const stat = fontUse.get(item.fontName) || { items: 0 };
    stat.items += 1;
    fontUse.set(item.fontName, stat);
  }
  const letters = (text) => [...String(text || '')].filter((ch) => LETTER.test(ch)).length;
  const pageLetters = items.reduce((sum, item) => sum + letters(item.str), 0);
  const pageArabic = items.reduce((sum, item) => sum + (ARABIC_SCRIPT.test(item.str) ? letters(item.str) : 0), 0);
  const mostlyArabic = pageLetters > 0 && pageArabic / pageLetters >= 0.7;
  const allRows = new Map();
  for (const item of items) {
    const key = Math.round(item.y * 2) / 2;
    if (!allRows.has(key)) allRows.set(key, []);
    allRows.get(key).push(item);
  }
  const delimiterFonts = new Set();
  const marked = new Set();
  for (const [, row] of allRows) {
    const rowHasArabic = row.some((item) => ARABIC_SCRIPT.test(item.str));
    if (!rowHasArabic && !mostlyArabic) continue;
    for (const run of latinRuns(row, arabicFonts, fontUse)) {
      const runLetters = run.flatMap((item) => [...item.str].filter((ch) => LETTER.test(ch)));
      if (runLetters.length < 2) continue;
      // real Latin text comes in words; a broken mapping never does
      if (run.some((item) => looksLikeWord(item.str))) continue;
      // letters outside A-Za-z: an Arabic diacritic or a verse rendered as Latin-1
      const alien = runLetters.every((ch) => !/[A-Za-z]/u.test(ch));
      const bracketed = run.length >= 3 && run[0].str.trim().length <= 2 && run[run.length - 1].str.trim().length <= 2;
      // a decorative line with no Arabic on an Arabic page is an ornament, not text
      const ornament = !rowHasArabic && runLetters.length >= 3;
      if (!alien && !bracketed && !ornament) continue;
      delimiterFonts.add(run[0].fontName);
      for (const item of run) marked.add(item);
    }
  }
  // a lone glyph of a delimiter font is the same broken quote, just split across lines
  for (const item of marked) {
    const letters = [...String(item.str || '')].filter((ch) => LETTER.test(ch)).length || 1;
    item.str = REPLACEMENT.repeat(letters);
    item.corrupt = true;
    stats.runs += 1;
  }
  for (const item of items) {
    if (marked.has(item) || !delimiterFonts.has(item.fontName)) continue;
    if ([...String(item.str || '')].filter((ch) => LETTER.test(ch)).length !== 1) continue;
    const row = allRows.get(Math.round(item.y * 2) / 2) || [];
    if (!row.some((entry) => ARABIC_SCRIPT.test(entry.str))) continue;
    item.str = REPLACEMENT;
    item.corrupt = true;
    stats.runs += 1;
  }
  // a decorative title whose glyphs are glued to Arabic words hides the same noise inside
  // one item ("الوzzztدÎ"), so the run is looked for inside the item as well
  for (const item of items) {
    if (marked.has(item)) continue;
    const text = String(item.str || '');
    if (!ARABIC_SCRIPT.test(text)) continue;
    const chars = [...text];
    let index = 0;
    let touched = false;
    while (index < chars.length) {
      if (!/[A-Za-z\u00C0-\u024F]/u.test(chars[index])) { index += 1; continue; }
      let end = index;
      while (end < chars.length && /[A-Za-z\u00C0-\u024F]/u.test(chars[end])) end += 1;
      const run = chars.slice(index, end).join('');
      if (run.length >= 3 && !/[aeiouyAEIOUY]/u.test(run) && !looksLikeWord(run)) {
        for (let k = index; k < end; k += 1) chars[k] = REPLACEMENT;
        touched = true;
        stats.runs += 1;
      }
      index = end;
    }
    if (touched) { item.str = chars.join(''); item.corrupt = true; }
  }
  return stats;
}

/** Maximal stretches of non-Arabic items that no Arabic item interrupts inside one row. */
function latinRuns(row, arabicFonts, fontUse) {
  const runs = [];
  const arabicX = row.filter((item) => ARABIC_SCRIPT.test(item.str)).map((item) => [item.x, item.x + item.w]).sort((a, b) => a[0] - b[0]);
  // a font that carries a whole page of text is real text, not a broken decorative font
  const decorative = (fontName) => !arabicFonts.has(fontName) && (fontUse.get(fontName)?.items || 0) <= 30;
  const sorted = row.filter((item) => !ARABIC_SCRIPT.test(item.str)).sort((a, b) => a.x - b.x);
  let current = [];
  for (const item of sorted) {
    if (!decorative(item.fontName)) {
      if (current.length) runs.push(current);
      current = [];
      continue;
    }
    const blocked = arabicX.some(([left, right]) => right > item.x + 0.5 && left < item.x + item.w - 0.5);
    if (blocked) {
      if (current.length) runs.push(current);
      current = [];
      continue;
    }
    current.push(item);
  }
  if (current.length) runs.push(current);
  return runs;
}

// -------------------------------------------------------------- page geometry

function measure(item) {
  const transform = item.transform || [1, 0, 0, 1, 0, 0];
  const height = Math.abs(item.height || 0) || Math.abs(transform[3]) || Math.abs(transform[0]) || 10;
  return {
    str: String(item.str || ''),
    x: transform[4],
    y: transform[5],
    w: Number(item.width || 0),
    h: height,
    fontName: item.fontName,
    rotated: Math.abs(transform[1]) > 0.25 || Math.abs(transform[2]) > 0.25,
  };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The same item drawn again on the very same spot (hidden overlay) is dropped. */
function dropSameSpotDuplicates(items) {
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  for (const item of items) {
    const key = `${Math.round(item.x * 2) / 2}|${Math.round(item.y * 2) / 2}|${item.str}`;
    if (seen.has(key)) { dropped += 1; continue; }
    seen.add(key);
    kept.push(item);
  }
  return { kept, dropped };
}

/**
 * Some pages carry the whole text block several times, each copy a fraction of a point off the
 * original, so the copies land inside each other's lines (see mathematics p94: seven copies of
 * the same exercises, every one of them extracted). Nothing in the geometry says which copy is
 * painted, but a copy repeats an earlier *run* of glyphs verbatim, so the repeat is recognised
 * as such: only a run of six or more consecutive items that already occurred earlier is dropped,
 * and the first occurrence is kept. Two tokens that merely look alike (a second `−`, another `(`)
 * are never touched.
 */
function dropRepeatedBlocks(items) {
  const size = 6;
  const keys = items.map((item) => item.str);
  const total = keys.length;
  const seen = new Map();
  const doomed = new Set();
  for (let i = 0; i + size <= total; i += 1) {
    const key = keys.slice(i, i + size).join('\u0001');
    const first = seen.get(key);
    if (first === undefined) { seen.set(key, i); continue; }
    let length = size;
    while (i + length < total && first + length < total && keys[i + length] === keys[first + length]) length += 1;
    for (let k = 0; k < length; k += 1) doomed.add(i + k);
    i += length - 1;
  }
  return { kept: items.filter((_, index) => !doomed.has(index)), dropped: doomed.size };
}

/** Group items into rows by their baseline. */
function clusterRows(items) {
  const upright = items.filter((item) => !item.rotated);
  const rotated = items.filter((item) => item.rotated);
  const sorted = [...upright].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const item of sorted) {
    let target = null;
    for (const row of rows) {
      const tolerance = Math.max(0.9, 0.34 * Math.max(row.height, item.h));
      if (Math.abs(row.baseline - item.y) <= tolerance) { target = row; break; }
    }
    if (!target) {
      target = { baseline: item.y, height: item.h, items: [] };
      rows.push(target);
    }
    target.items.push(item);
    target.height = Math.max(target.height, item.h);
  }
  rows.sort((a, b) => b.baseline - a.baseline);
  const rotatedRows = rotated.map((item) => ({ baseline: item.y, height: item.h, items: [item], vertical: true }));
  rotatedRows.sort((a, b) => b.items[0].x - a.items[0].x);
  return rows.concat(rotatedRows);
}

/** Re-attach the glyphs that sit above or below their row (super/subscripts). */
function buildRows(rows) {
  const baseHeight = median(rows.flatMap((row) => row.items.map((item) => item.h))) || 10;
  const isScript = (item) => item.h < 0.86 * baseHeight && item.w < 1.6 * baseHeight;
  // an exponent or an index never sits on a whole Arabic sentence, and never on a sign
  const canHost = (item) => (LETTER.test(item.str) || DIGIT.test(item.str)) && compactText(item.str).length <= 6;
  const attachCost = (script, host) => {
    const overlap = Math.min(script.x + script.w, host.x + host.w) - Math.max(script.x, host.x);
    const gap = Math.max(0, host.x - (script.x + script.w), script.x - (host.x + host.w));
    return gap + 3 * Math.max(0, overlap);
  };
  const scripts = [];
  for (const row of rows) {
    const loose = row.items.filter(isScript);
    if (!loose.length) continue;
    const anchored = row.items.filter((item) => !isScript(item));
    row.items = anchored;
    // the row that sits closest *under the glyphs*, not the closest one in y: an
    // exponent is exactly half way between the line it belongs to and the line below
    let best = null;
    for (const other of rows) {
      if (other === row) continue;
      const delta = Math.abs(other.baseline - row.baseline);
      if (delta < 0.15 * baseHeight || delta > 1.6 * baseHeight) continue;
      let total = 0;
      let usable = true;
      for (const script of loose) {
        let gap = Infinity;
        for (const candidate of other.items) {
          if (!canHost(candidate)) continue;
          gap = Math.min(gap, attachCost(script, candidate));
        }
        if (!Number.isFinite(gap)) { usable = false; break; }
        total += gap;
      }
      if (!usable) continue;
      if (!best || total < best.total || (total === best.total && delta < best.delta)) best = { other, total, delta };
    }
    if (!best || best.total > 1.6 * baseHeight) {
      row.items.push(...loose);
      continue;
    }
    for (const script of loose) {
      let host = null;
      let hostCost = Infinity;
      for (const candidate of best.other.items) {
        if (!canHost(candidate)) continue;
        const cost = attachCost(script, candidate);
        if (cost < hostCost) { hostCost = cost; host = candidate; }
      }
      if (!host) { row.items.push(script); continue; }
      const digit = SUPERSCRIPT[script.str.trim()];
      host.str += script.y > host.y ? (digit || script.str) : `_${script.str}`;
      scripts.push(script.str);
    }
    row.items.sort((a, b) => a.x - b.x);
  }
  return { rows, scripts, baseHeight };
}

/** A wide item made of repeated rule glyphs is a fraction bar: it owns the glyphs around it. */
function isRule(item) {
  const text = item.str.replace(/\s+/gu, '');
  if (!text) return false;
  if (LETTER.test(text) || DIGIT.test(text)) return false;
  // a row of dashes or dots is an answer blank or a sign chart, never a fraction
  if (/^[-—–_.•·…]+$/u.test(text)) return false;
  return item.w >= 2.2 * item.h && [...text].every((ch) => ch === text[0]);
}

function mergeFractions(rows) {
  const taken = new Set();
  let rules = 0;
  for (const row of rows) {
    for (const item of row.items) {
      if (taken.has(item) || !isRule(item)) continue;
      const span = item.h;
      const candidates = [];
      for (const other of rows) {
        if (other === row || !other.items.length) continue;
        const delta = other.baseline - item.y;
        if (Math.abs(delta) < 0.15 * span || Math.abs(delta) > 1.9 * span) continue;
        // only the glyphs that sit inside the rule belong to the fraction, and they
        // have to be centred under it — otherwise it is the neighbouring text line
        const inside = other.items
          .filter((entry) => entry.x >= item.x - 0.4 * span && entry.x + entry.w <= item.x + item.w + 0.4 * span)
          .sort((a, b) => a.x - b.x);
        if (!inside.length || inside.length > 8) continue;
        const min = inside[0].x;
        const max = inside[inside.length - 1].x + inside[inside.length - 1].w;
        if (Math.abs((min - item.x) - (item.x + item.w - max)) > 0.45 * item.w) continue;
        candidates.push({ other, items: inside, delta, distance: Math.abs(delta) });
      }
      const above = candidates.filter((entry) => entry.delta > 0).sort((a, b) => a.distance - b.distance)[0];
      const below = candidates.filter((entry) => entry.delta < 0).sort((a, b) => a.distance - b.distance)[0];
      const numerator = above ? above.items : [];
      const denominator = below ? below.items : [];
      if (!numerator.length && !denominator.length) continue;
      const side = (list) => [...list].sort((a, b) => b.x - a.x).map((entry) => entry.str.trim()).filter(Boolean).join(' ');
      item.str = `${numerator.length ? `${side(numerator)} / ` : '/ '}${side(denominator)}`;
      item.rule = true;
      rules += 1;
      for (const candidate of numerator.concat(denominator)) taken.add(candidate);
    }
  }
  const kept = [];
  for (const row of rows) {
    const items = row.items.filter((item) => !taken.has(item));
    if (items.length) kept.push({ ...row, items });
  }
  kept.sort((a, b) => b.baseline - a.baseline);
  return { rows: kept, rules };
}

function rowDirection(items) {
  let arabic = 0;
  let latin = 0;
  for (const item of items) {
    if (ARABIC.test(item.str)) arabic += [...item.str].length;
    if (LATIN.test(item.str)) latin += [...item.str].length;
  }
  return arabic > latin ? 'rtl' : 'ltr';
}

/** Wide horizontal gaps are column boundaries, not word spaces. */
function splitSegments(items) {
  if (items.length < 2) return [items];
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) gaps.push(sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w));
  const width = median(sorted.map((item) => item.w)) || 10;
  const height = median(sorted.map((item) => item.h)) || 10;
  const limit = Math.max(1.6 * width, 2.4 * height, 26);
  const segments = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w);
    if (gap > limit) segments.push([sorted[i]]);
    else segments[segments.length - 1].push(sorted[i]);
  }
  return segments;
}

function rowToLine(row) {
  const direction = row.vertical ? 'rtl' : rowDirection(row.items);
  const segments = row.vertical ? [row.items] : splitSegments(row.items);
  const ordered = segments.map((segment) => [...segment].sort(direction === 'rtl' ? (a, b) => b.x - a.x : (a, b) => a.x - b.x));
  if (direction === 'rtl') ordered.reverse();
  return ordered
    .map((segment) => segment.map((item) => item.str.trim()).join(' ').replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join('  ');
}

/**
 * Two items that share the same text and sit on top of each other are the painted-over text
 * layer: the copies drift a few tenths of a point sideways, so an exact position match is not
 * enough — an overlap of more than half the glyph box is.
 */
function dropOverlappingDuplicates(rows) {
  let dropped = 0;
  for (const row of rows) {
    const kept = [];
    for (const item of [...row.items].sort((a, b) => a.x - b.x)) {
      const twin = kept.some((other) => other.str === item.str
        && Math.abs(other.x - item.x) <= 0.6 * Math.max(other.h, item.h));
      if (twin) { dropped += 1; continue; }
      kept.push(item);
    }
    row.items = kept;
  }
  return dropped;
}

/** The same line painted several times on one page (invisible text layer) → keep one. */
function dropGhostLines(lines) {
  const seen = new Set();
  const kept = [];
  const keepIndex = [];
  let dropped = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const key = compactText(line);
    if (key.length < 6) { kept.push(line); keepIndex.push(index); continue; }
    if (seen.has(key)) { dropped += 1; continue; }
    seen.add(key);
    kept.push(line);
    keepIndex.push(index);
  }
  return { kept, keepIndex, dropped };
}

function buildPageText(items, stream, defectsByFont) {
  const stats = { items: 0, sameSpot: 0, copies: 0, copyShare: 0, overlap: 0, scripts: 0, rules: 0, ghostLines: 0, digits: 0, digitItems: 0, corrupt: 0 };
  const printable = items.filter((item) => item && typeof item.str === 'string' && item.str.replace(/\s+/gu, ''));
  const repaired = repairItemDigits(printable, stream, defectsByFont);
  stats.digits = repaired.stats.glyphs;
  stats.digitItems = repaired.stats.items;
  const measured = repaired.items.map(measure);
  const pageHasArabic = ARABIC_SCRIPT.test(measured.map((item) => item.str).join(''));
  const untrusted = markUntrustedRuns(measured, stream, pageHasArabic);
  stats.corrupt = untrusted.runs;
  stats.items = measured.length;
  const deduped = dropSameSpotDuplicates(measured);
  stats.sameSpot = deduped.dropped;
  const copies = dropRepeatedBlocks(deduped.kept);
  stats.copies = copies.dropped;
  stats.copyShare = copies.dropped / Math.max(1, deduped.kept.length);
  let rows = clusterRows(copies.kept);
  stats.overlap = dropOverlappingDuplicates(rows);
  rows = rows.filter((row) => row.items.length);
  const firstGhost = dropGhostLines(rows.map((row) => rowToLine(row)));
  const keptRows = firstGhost.keepIndex.map((index) => rows[index]);
  stats.ghostLines = rows.length - keptRows.length;
  const built = buildRows(keptRows);
  stats.scripts = built.scripts.length;
  const fractions = mergeFractions(built.rows);
  stats.rules = fractions.rules;
  const lines = [];
  for (const row of fractions.rows) {
    const line = rowToLine(row);
    if (line) lines.push(line);
  }
  const ghosts = dropGhostLines(lines);
  stats.ghostLines += ghosts.dropped;
  return { lines: ghosts.kept, stats };
}

// ---------------------------------------------------------------- page records

function titleFor(lines, page, book, previousTitle) {
  const candidates = lines.filter((line) => {
    const text = clean(line);
    if (text.length < 4 || text.length > 140) return false;
    if (FOLIO.test(text)) return false;
    return LETTER.test(text) || DIGIT.test(text);
  });
  const pageNumber = page.printedPage || page.physicalPage;
  if (!candidates.length) {
    return lines.length ? `صفحة ${pageNumber} من ${book.subject}` : `صفحة مصورة من ${book.title}`;
  }
  const heading = /^(الفصل|الباب|الوحدة|وحدة|المحور|محور|درس|تمارين|تمرين|تدريبات|نشاط|أنشطة|أسئلة|اسئلة|فهرس|الفهرس|المحتويات|ملخص|خلاصة|تذكر|unit|chapter|lesson|exercise|exercises|glossary|contents|review)/iu;
  let best = candidates[0];
  let bestScore = -Infinity;
  for (let i = 0; i < candidates.length; i += 1) {
    const text = clean(candidates[i]);
    let score = 0;
    if (heading.test(text)) score += 4;
    if (i < 3) score += 2 - i * 0.5;
    if (text.length <= 90) score += 1;
    if (/[؟?!.؛:](\s|$)/u.test(text) && text.length > 40) score -= 3;
    if (DIGIT.test(text) && !ARABIC.test(text)) score -= 2;
    if (text.replace(/[^\p{L}]/gu, '').length < 4) score -= 3;
    // mojibake and half-replaced runs are never a title
    if (text.includes(REPLACEMENT)) score -= 4;
    if ((text.match(/[\u00A0-\u024F]/gu) || []).length >= 2) score -= 3;
    const letters = text.replace(/[^\p{L}]/gu, '').length || 1;
    if (ARABIC.test(text) && (text.match(ARABIC) || []).length / letters < 0.4) score -= 2;
    if (previousTitle && compactText(text) === compactText(previousTitle)) score -= 2.5;
    if (score > bestScore) { bestScore = score; best = candidates[i]; }
  }
  let title = clean(best).slice(0, 140);
  if (previousTitle && compactText(title) === compactText(previousTitle)) {
    const suffix = ` — صفحة ${pageNumber}`;
    title = `${title.slice(0, Math.max(20, 140 - suffix.length))}${suffix}`;
  }
  return title;
}

function pageTypeFor(lines) {
  const text = lines.join('\n');
  const compact = compactText(text);
  if (!lines.length || compact.length < 12) return { pageType: 'divider', reason: 'صفحة بلا نص مستخرج' };
  const first = lines.slice(0, 3).join(' ');
  const dotLeaders = lines.filter((line) => /\.{2,}\s*\d+/u.test(line)).length;
  const folioOnly = lines.filter((line) => FOLIO.test(clean(line))).length;
  if (/(^|\s)(فهرس|الفهرس|المحتويات|فهرس المحتويات|table of contents|contents)(\s|$)/iu.test(first)
    || dotLeaders >= 4 || (folioOnly >= 6 && lines.length <= folioOnly + 6)) {
    return { pageType: 'contents', reason: 'فهرس أو قائمة صفحات' };
  }
  const numbered = lines.filter((line) => /^\s*[()[\u00AB]?\s*(?:\d{1,2}|[أ-ي])\s*[).\-,\u00BB\]]/u.test(line)).length;
  const exerciseWords = (text.match(/(تمارين|تمرين|تدريبات|تدريب|أنشطة|نشاط|اسأل|أسئلة|سؤال|اختبر|اكتب|بيّن|اقرأ|ضع\s|جد\s)/giu) || []).length;
  if (numbered >= 4 || (exerciseWords >= 3 && numbered >= 1) || (exerciseWords >= 2 && numbered >= 2)) {
    return { pageType: 'exercises', reason: 'أوامر وتمارين مرقّمة' };
  }
  if (/(^|\s)(ماذا تعلمنا|خلاصة الوحدة|ملخص الوحدة|ملخص الدرس|the story so far|matters so far|تذكر|مراجعة سريعة|ملخص)( |\s|$)/iu.test(text)) {
    return { pageType: 'boxed_recap', reason: 'صندوق ملخص' };
  }
  if (/(وصل|وصّل|اربط|matching|match the|التطابق)/iu.test(text) && numbered >= 1) {
    return { pageType: 'matching', reason: 'تمرين ربط' };
  }
  const termLines = lines.filter((line) => /[A-Za-z][A-Za-z\s'’-]{2,24}\s*[-–—/]\s*[\u0600-\u06FF]/u.test(line)
    || /[\u0600-\u06FF][\u0600-\u06FF\s]{2,24}\s*[-–—/،]\s*[A-Za-z]/u.test(line)).length;
  if (termLines >= 4 || /(المصطلحات|المصطلح|المعاني|المعجم|glossary|vocabulary)/iu.test(first)) {
    return { pageType: 'glossary', reason: 'جدول مصطلحات' };
  }
  const bilingual = lines.filter((line) => ARABIC.test(line) && LATIN.test(line)).length;
  if (bilingual >= 4) return { pageType: 'parallel_text', reason: 'مفردات مع ترجمة' };
  const chapter = lines.slice(0, 2).map(clean).find((line) => /^(الفصل|الباب|الوحدة|المحور|درس)\b/u.test(line));
  if (chapter && compact.length < 420) return { pageType: 'divider', reason: 'صفحة فتح وحدة' };
  if (compact.length < 180 && lines.length <= 4) return { pageType: 'divider', reason: 'صفحة عنوان قصيرة' };
  return { pageType: 'lesson_content', reason: 'محتوى درس' };
}

function outlineFor(book, pages) {
  const lines = [
    `# فهرس مادة: ${book.subject}`,
    '',
    `- **الكتاب**: ${book.title}`,
    '- **المرحلة**: السادس الإعدادي الإسلامي — ديوان الوقف السني',
    `- **عدد صفحات PDF**: ${pages.length}`,
    `- **الطبعة المسجلة**: ${book.edition || 'غير ظاهرة في بيانات الغلاف'}`,
    '- **قاعدة الدقة**: النص المستخرج من PDF دليل نصي؛ الصفحات المصورة بلا نص لا يجوز اقتباس محتواها.',
    '',
    '## التفاصيل صفحة بصفحة',
  ];
  for (const page of pages) {
    const title = page.title || 'صفحة مصورة تحتاج قراءة بصرية';
    const detail = page.fullText
      ? `مقتطف فهرسي من النص المستخرج: ${clean(page.fullText).slice(0, 500)}`
      : 'لا يتوفر نص قابل للاستخراج من هذه الصفحة؛ تحتاج قراءة بصرية قبل الإجابة عن تفاصيلها.';
    lines.push(
      '',
      `### الصفحة الفيزيائية ${page.physicalPage}`,
      `- **النوع**: ${page.searchable ? 'نص مستخرج من PDF' : 'صفحة مصورة'}`,
      `- **نوع الصفحة**: ${page.pageType}`,
      `- **العنوان الرسمي**: ${title}`,
      `- **المحتوى**: ${detail}`,
      `- **ملاحظة للاستخدام**: ${page.searchable ? 'يمكن الاستشهاد بالنص المستخرج بعد فحص موضعه.' : 'لا تنسب إليها نصًا أو حكمًا أو رقمًا قبل القراءة البصرية.'}`,
    );
    if (page.textNotes && page.textNotes.length) lines.push(`- **تحذير الاستخراج**: ${page.textNotes.join(' · ')}`);
  }
  return `${lines.join('\n')}\n`;
}

function printedPageFor(spec, physicalPage) {
  const offsets = {
    'quran-readings-deni-sixth': { first: 6, offset: -4 },
    'fiqh-shafii-deni-sixth': { first: 6, offset: -4 },
    'history-deni-sixth': { first: 1, offset: 0 },
    'arabic-grammar-deni-sixth': { first: 5, offset: 0 },
    'balagha-deni-sixth': { first: 6, offset: -4 },
    'english-deni-sixth': { first: 6, offset: 0 },
    'mathematics-deni-sixth': { first: 1, offset: 0 },
    'hadith-deni-sixth': { first: 7, offset: -5 },
  }[spec.id];
  if (!offsets || physicalPage < offsets.first) return null;
  return physicalPage + offsets.offset;
}

// ---------------------------------------------------------------------- driver

function sumStats(pages, key) {
  return pages.reduce((sum, page) => sum + (page.textStats ? page.textStats[key] || 0 : 0), 0);
}

async function main() {
await mkdir(BOOKS_DIR, { recursive: true });
await mkdir(OUTLINES_DIR, { recursive: true });
const index = JSON.parse(await readFile(SOURCE_INDEX_FILE, 'utf8'));
let importedBooks = 0;
let updatedMetadata = false;
let totalPages = 0;
let searchablePages = 0;
const totals = { sameSpot: 0, ghostLines: 0, scripts: 0, rules: 0, digits: 0, digitItems: 0, corrupt: 0 };
const typeDistribution = {};
const digitDefects = new Map();

for (const spec of BOOKS) {
  if (ONLY && !ONLY.has(spec.id)) continue;
  if (!REBUILD && index.books.some((book) => book.id === spec.id)) {
    if (spec.id === 'fiqh-hanafi-deni-sixth') {
      const bookFile = path.join(BOOKS_DIR, `${spec.id}.json`);
      const book = JSON.parse(await readFile(bookFile, 'utf8'));
      const entry = index.books.find((candidate) => candidate.id === spec.id);
      if (book.track !== 'ديني إضافي' || !book.supplementary || entry?.track !== 'ديني إضافي') {
        book.track = 'ديني إضافي';
        book.supplementary = true;
        if (entry) { entry.track = book.track; entry.supplementary = true; }
        await writeFile(bookFile, `${JSON.stringify(book)}\n`);
        updatedMetadata = true;
      }
    }
    console.log(`موجود مسبقًا: ${spec.id}`);
    continue;
  }
  const filePath = path.join(SOURCES, spec.file);
  const bytes = await readFile(filePath);
  if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error(`ملف PDF غير صالح: ${spec.file}`);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const source = {
    type: 'pdf', fileName: spec.file, bytes: bytes.length, checksum, authoritative: true, url: spec.url,
  };
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  if (doc.numPages !== spec.expectedPages) throw new Error(`عدد صفحات غير متوقع لـ ${spec.id}: ${doc.numPages}`);
  const pages = [];
  const pending = [];
  const bookDigits = new Map();
  const defectsByFont = new Map();
  const addDefect = (defects, font) => {
    const known = defectsByFont.get(font) || [];
    for (const defect of defects) {
      if (known.some((entry) => entry.code === defect.code)) continue;
      known.push(defect);
    }
    defectsByFont.set(font, known);
    digitDefects.set(`${spec.id}/${font}`, known);
  };
  let previousTitle = '';
  const bookTypes = {};
  for (let physicalPage = 1; physicalPage <= doc.numPages; physicalPage += 1) {
    const pdfPage = await doc.getPage(physicalPage);
    const rawItems = (await pdfPage.getTextContent()).items;
    let stream = { ok: false, glyphs: [], digits: new Map() };
    if (USE_GLYPHS) {
      stream = await glyphStreamOf(pdfPage);
      // a font only shows a few of its digits on any single page, so the digit map of the
      // whole book has to be collected before a broken mapping can be called broken
      for (const [font, digits] of stream.digits) {
        const merged = bookDigits.get(font) || new Map();
        for (const [code, value] of digits) if (!merged.has(code)) merged.set(code, value);
        bookDigits.set(font, merged);
        const found = digitRunDefects(digits);
        if (found.length) addDefect(found, font);
      }
    }
    pending.push({ physicalPage, items: rawItems, stream });
    await pdfPage.cleanup();
  }
  await doc.destroy();

  for (const [font, digits] of bookDigits) {
    const defects = digitRunDefects(digits);
    if (defects.length) addDefect(defects, font);
  }

  for (const entry of pending) {
    const built = buildPageText(entry.items, entry.stream, defectsByFont);
    const fullText = built.lines.join('\n').trim();
    // the floor decides the searchable flag exactly as before, but a short readable line is
    // still written: dropping it would lose a unit label on a picture page
    const searchable = fullText.length >= 20 && !CJK.test(fullText);
    const printedPage = printedPageFor(spec, entry.physicalPage);
    const classified = pageTypeFor(searchable ? built.lines : []);
    const textNotes = [];
    if (built.stats.digitItems) textNotes.push(`أُعيد بناء ${built.stats.digitItems} رقماً لأن خريطة الخط في ملف PDF تضع الصفر على القيمة 1`);
    if (built.stats.corrupt) textNotes.push(`${built.stats.corrupt} مقطعاً نصياً بلا ربط عربي صالح استُبدل بعلامة تلف`);
    const page = {
      physicalPage: entry.physicalPage,
      printedPage,
      pageNumber: entry.physicalPage,
      printedPageNumber: printedPage,
      fullText,
      searchable,
      ocr: { required: !searchable, status: searchable ? 'text' : 'needed', engine: searchable ? 'pdf-text' : 'none' },
      needsOcr: !searchable,
      title: searchable ? titleFor(built.lines, { physicalPage: entry.physicalPage, printedPage }, spec, previousTitle) : `صفحة مصورة — ${spec.subject}`,
      summary: searchable ? `نص الصفحة مستخرج من كتاب ${spec.subject}؛ راجعي المقتطف أو افتحي الصفحة للتفاصيل.` : `صفحة مصورة من كتاب ${spec.subject} لا يتوفر لها نص مستخرج بعد.`,
      section: spec.subject,
      unit: '',
      pageType: classified.pageType,
      pageTypeReason: classified.reason,
      educationalPurpose: '',
      textNotes,
      textStats: {
        items: built.stats.items,
        sameSpotDropped: built.stats.sameSpot,
        paintedCopiesDropped: built.stats.copies,
        ghostLinesDropped: built.stats.ghostLines,
        scriptsGlued: built.stats.scripts,
        fractionRules: built.stats.rules,
        digitsRepaired: built.stats.digitItems,
        corruptRuns: built.stats.corrupt,
      },
      sourceProvenance: { type: 'pdf', fileName: spec.file, physicalPage: entry.physicalPage, authority: 'official-reference', checksum },
    };
    if (searchable) previousTitle = page.title;
    bookTypes[page.pageType] = (bookTypes[page.pageType] || 0) + 1;
    totals.sameSpot += built.stats.sameSpot;
    totals.ghostLines += built.stats.ghostLines;
    totals.scripts += built.stats.scripts;
    totals.rules += built.stats.rules;
    totals.digits += built.stats.digits;
    totals.digitItems += built.stats.digitItems;
    totals.corrupt += built.stats.corrupt;
    pages.push(page);
  }

  const book = {
    schemaVersion: 1,
    id: spec.id,
    title: spec.title,
    subject: spec.subject,
    grade: 'السادس الإعدادي الإسلامي',
    branch: 'ديني',
    track: 'ديني',
    supplementary: spec.id === 'fiqh-hanafi-deni-sixth',
    edition: spec.edition,
    year: spec.year,
    publisher: 'ديوان الوقف السني — دائرة التعليم الديني والدراسات الإسلامية',
    referenceKind: 'official-textbook',
    pageCount: pages.length,
    searchablePageCount: pages.filter((page) => page.searchable).length,
    source,
    pages,
  };
  await writeFile(path.join(BOOKS_DIR, `${spec.id}.json`), `${JSON.stringify(book)}\n`);
  await writeFile(path.join(OUTLINES_DIR, `${spec.id}.md`), outlineFor(book, pages));
  const { schemaVersion: _schemaVersion, ...indexBook } = book;
  const at = index.books.findIndex((candidate) => candidate.id === spec.id);
  if (at >= 0) index.books[at] = indexBook;
  else index.books.push(indexBook);
  importedBooks += 1;
  totalPages += pages.length;
  searchablePages += book.searchablePageCount;
  const distribution = PAGE_TYPES.filter((type) => bookTypes[type]).map((type) => `${type}=${bookTypes[type]}`).join(' ');
  console.log(`${spec.subject}: ${pages.length} صفحة · ${book.searchablePageCount} نصية · ${distribution}`);
  console.log(`   تنظيف: نسخ مكرّرة ${sumStats(pages, 'sameSpotDropped')} · أسطر مخفية ${sumStats(pages, 'ghostLinesDropped')} · أسوأل/حروف سفلية ${sumStats(pages, 'scriptsGlued')} · كسور ${sumStats(pages, 'fractionRules')} · أرقام ${sumStats(pages, 'digitsRepaired')} · تلف ${sumStats(pages, 'corruptRuns')}`);
  for (const [type, count] of Object.entries(bookTypes)) typeDistribution[type] = (typeDistribution[type] || 0) + count;
}

if (importedBooks || updatedMetadata) {
  const temp = `${INDEX_FILE}.tmp`;
  await writeFile(temp, `${JSON.stringify(index)}\n`);
  await rename(temp, INDEX_FILE);
} else {
  console.log('\nكل الكتب موجودة في الفهرس؛ استعمل --force أو --out-dir لإعادة الاستخراج.');
}
console.log(`\nمجلد المخرجات: ${TARGET}`);
console.log(`كتب: ${importedBooks} · صفحات: ${totalPages} · نصية: ${searchablePages}`);
console.log(`تنظيف: نسخ مكرّرة في نفس الموضع ${totals.sameSpot} · أسطر طبقة مخفية ${totals.ghostLines} · أسوأل/حروف سفلية ${totals.scripts} · خطوط كسور ${totals.rules} · أرقام مُصلَحة ${totals.digitItems} · مقاطع تلف ${totals.corrupt}`);
console.log(`توزيع pageType: ${PAGE_TYPES.map((type) => `${type}=${typeDistribution[type] || 0}`).join(' ')}`);
if (digitDefects.size) {
  console.log('\nعيوب خرائط الخطوط داخل ملفات PDF (تُوثَّق ولا تُختلق قيمها):');
  for (const [key, defects] of digitDefects) {
    console.log(`  ${key}: ${defects.map((defect) => `code 0x${defect.code.toString(16)} → "${defect.brokenValue}" والصحيح "${defect.fixedValue}"`).join('، ')}`);
  }
}
}

export {
  BOOKS,
  dropRepeatedBlocks,
  splitSegments,
  rowDirection,
  buildRows,
  clusterRows,
  dropGhostLines,
  dropOverlappingDuplicates,
  dropSameSpotDuplicates,
  measure,
  mergeFractions,
  rowToLine,
  PAGE_TYPES,
  buildPageText,
  digitRunDefects,
  glyphStreamOf,
  looksLikeWord,
  markUntrustedRuns,
  pageTypeFor,
  titleFor,
};

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) await main();