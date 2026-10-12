// إعادة بناء ترتيب القراءة من نتيجة pdfjs getTextContent(): التسوية السطحية في
// lib/pdf-fallback.mjs كانت تُقرأ البنود بالترتيب الذي يرسله الـPDF، فصفحة
// بعمودين أو جدول تختلط فيها الأسطر («الفلوجة ... بغداد ... الفلوجة ... بغداد»)
// ولا يُفهم النص. هذا الملف يجمع البنود في أسطر بحسب y، ويترجم الفواصل
// الأفقية الواسعة إلى خلايا جدول، فيخرج النص بترتيب قراءته.
const ROW_HEIGHT = 2;
const COLUMN_GAP = 28;
const SPACE_GAP = 6;
const ADVANCE_RATIO = 5.5;
const MIN_ADVANCE = 4;

// «—» خلية فاردة: تُحفظ في الجدول كما هي لأن غياب إحداها في جدول مقارنات
// (سعر/وزن/بلد) دلالةٌ لا يُغني عنها حذف الخلية.
const EMPTY_CELL = '—';

function itemsOf(textContent) {
  const items = Array.isArray(textContent) ? textContent : textContent?.items;
  return Array.isArray(items) ? items : [];
}

function itemPoint(item) {
  const transform = Array.isArray(item?.transform) ? item.transform : null;
  let x = transform && transform.length >= 6 ? Number(transform[4]) : Number.NaN;
  let y = transform && transform.length >= 6 ? Number(transform[5]) : Number.NaN;
  if (!Number.isFinite(x)) x = Number(item?.x);
  if (!Number.isFinite(y)) y = Number(item?.y);
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}

export function detectColumns(items) {
  try {
    const rows = groupRows(itemsOf(items));
    if (!rows.length) return 1;
    let widest = 1;
    for (const row of rows) {
      let columns = 1;
      for (const cell of row.cells) if (cell.gap > COLUMN_GAP) columns += 1;
      if (columns > widest) widest = columns;
    }
    return Math.min(3, Math.max(1, widest));
  } catch {
    return 1;
  }
}

export function rowsToTable(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((row) => String(row ?? ''))
    .map((row) => (row.includes('\t')
      ? row.split('\t').map((cell) => cell.trim() || EMPTY_CELL).join(' | ')
      : row))
    .join('\n');
}

// الخط الثابت للخلية: pdfjs لا يُعطي عرضاً موثوقاً، فتقديره من طول النص هو ما
// يفرّق بين تباعدٍ داخل الكلمة (kerning) ومسافةٍ بين كلمتين وعمودٍ ثانٍ.
function advanceOf(cell) {
  return Math.max(MIN_ADVANCE, cell.text.length * ADVANCE_RATIO);
}

// الفراغ بين خليتين في اتجاه القراءة نفسه: في صف عربي البث تنازلي، فأول ما
// يُقرأ هو الخلية اليمنى، والمسافة تُقاس من حافتها اليسرى إلى حافة ما بعدها.
function readingGap(previous, cell, descending) {
  return descending
    ? previous.x - (cell.x + advanceOf(cell))
    : cell.x - (previous.x + advanceOf(previous));
}

function groupRows(items) {
  const rows = new Map();
  for (const item of items) {
    const raw = item?.str ?? '';
    const text = String(raw).trim();
    if (!text) continue;
    const point = itemPoint(item);
    const rtl = String(item?.dir ?? '') === 'rtl';
    // y/2 لا y: فروق التحويل الرقمي تقسم السطر الواحد إلى ثلاثة أسطر.
    const key = Math.round(point.y / ROW_HEIGHT);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ text, x: point.x, y: point.y, rtl });
  }
  return [...rows.entries()]
    .map(([key, cells]) => {
      const ordered = cells.slice().sort((a, b) => a.x - b.x || a.y - b.y);
      let previous = null;
      for (const cell of ordered) {
        cell.gap = previous ? readingGap(previous, cell, false) : 0;
        previous = cell;
      }
      return { key, cells: ordered };
    })
    .sort((a, b) => b.key - a.key);
}

function rowLine(row) {
  const cells = row.cells;
  const rtlCount = cells.filter((cell) => cell.rtl).length;
  // العربية: الصف الذي أغلبيته rtl يُبَثّ بترتيب x تنازلياً، وإلا فتصاعدي.
  const descending = rtlCount * 2 > cells.length;
  const ordered = descending ? cells.slice().reverse() : cells;
  let line = '';
  let previous = null;
  for (const cell of ordered) {
    if (previous) {
      const gap = readingGap(previous, cell, descending);
      if (gap > COLUMN_GAP) line += '\t';
      else if (gap >= SPACE_GAP) line += ' ';
    }
    line += cell.text;
    previous = cell;
  }
  return line.replace(/[ \t]+$/, '');
}

export function reconstructText(textContent) {
  const lines = groupRows(itemsOf(textContent)).map(rowLine);
  return rowsToTable(lines).replace(/\n{3,}/g, '\n\n').trim();
}
