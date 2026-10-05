// Diagnostic: are the "years outside plausible range" findings real damage, or
// false positives from coordinates, ratios and page furniture?
import { readFile } from 'node:fs/promises';

const lib = new URL('../curriculum-library/', import.meta.url);
const index = JSON.parse(await readFile(new URL('search-index.json', lib), 'utf8'));

// Current detector in lib/index.mjs
const DAMAGE_YEAR = /(\d{4})\s*م/g;
const PLAUSIBLE = [1200, 2035];

// Contexts where a 4-digit number followed by م is NOT a year.
const CONTEXT = /(\d)\s*°|\d\s*'\s*\d|:\s*\d{2,4}\s*م|\d{4}\s*[-–/]\s*\d|صفحة\s*\d{4}|ط\s*\d{4}|\(\s*\d{4}\s*\)|=\s*\d{4}|\d{4}\s*=|\d\s*x\s*\d{4}/;

const rows = [];
for (const doc of index.documents) {
  const text = String(doc.text || '');
  if (!text) continue;
  const years = [...text.matchAll(DAMAGE_YEAR)].map((m) => Number(m[1]));
  const bad = [...new Set(years.filter((y) => y < PLAUSIBLE[0] || y > PLAUSIBLE[1]))];
  if (!bad.length) continue;
  // Capture surrounding context for each suspicious number.
  const contexts = [];
  for (const value of bad.slice(0, 4)) {
    const at = text.search(new RegExp(`${value}\\s*م`));
    contexts.push({
      value,
      around: at >= 0 ? text.slice(Math.max(0, at - 45), at + 25).replace(/\s+/g, ' ') : '(not found)',
    });
  }
  rows.push({ id: doc.id, count: bad.length, values: bad.slice(0, 6), contexts, text });
}

const falsePositive = rows.filter((r) => r.contexts.every((c) => CONTEXT.test(c.around) || /^0$|^1$|^2$|^3$/.test(String(c.value))));
console.log(`pages flagged by year rule: ${rows.length}`);
console.log(`pages where every hit looks like coordinate/furniture/ratio: ${falsePositive.length}`);
console.log('\nexamples of likely false positives:');
for (const row of falsePositive.slice(0, 10)) {
  for (const c of row.contexts) console.log(` ${row.id} [${c.value}] …${c.around}…`);
}
console.log('\nexamples that look like genuine OCR damage:');
for (const row of rows.filter((r) => !falsePositive.includes(r)).slice(0, 10)) {
  for (const c of row.contexts) console.log(` ${row.id} [${c.value}] …${c.around}…`);
}