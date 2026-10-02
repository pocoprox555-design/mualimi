import assert from 'node:assert';
import test from 'node:test';
import { crossBookDuplicates, deadLayers, foreignUnits, judgeNumbers, noTextPages, pageIntegrity, titleRepetition } from '../scripts/validate-rules.mjs';

const longText = 'نص صفحة كامل للاختبار '.repeat(20);
const page = (extra = {}) => ({ physicalPage: 1, printedPage: null, text: longText, title: '', summary: '', outlineSummary: '', ...extra });

test('سلامة الصفحة تُصنّف أربع حالات', () => {
  assert.equal(pageIntegrity(page()).state, 'intact');
  assert.equal(pageIntegrity({ text: '' }).state, 'empty');
  assert.equal(pageIntegrity({ text: 'سطر قصير' }).state, 'thin');
  assert.equal(pageIntegrity({ text: `${longText}�`, textDamaged: true }).state, 'damaged');
  assert.equal(pageIntegrity({ text: longText, needsOcr: true }).state, 'damaged');
});

test('الرقم المثبَت في نص الصفحة ليس فجوة', () => {
  const proven = judgeNumbers([page({ text: `${longText} 1805 `, summary: 'معركة عام 1805 انتهت' })]);
  assert.equal(proven.counts.unverified, 0);
  assert.equal(proven.counts.proven, 1);
  const missing = judgeNumbers([page({ text: `${longText} 1840 `, summary: 'بنود معاهدة لندن 1909' })]);
  assert.equal(missing.unverified.length, 1);
  assert.equal(missing.unverified[0].number, '1909');
});

test('غياب الرقم عن صفحة بلا نص طبقة لا يُحاسَب مقارنةً بل كتاباً كله', () => {
  const result = judgeNumbers([page({ text: '', needsOcr: true, summary: 'آيات 20 و26 من سورة الكهف' })]);
  assert.equal(result.counts.layerless, 2);
  assert.equal(result.counts.unverified, 0);
});

test('الملاحظة النصية لا تُبطل الدليل وحدها', () => {
  const result = judgeNumbers([page({ summary: 'آيتا 20 و26', notes: 'الرقم المقروء بصريا هو 20 و26 كما ورد في صورة الصفحة' })]);
  assert.equal(result.counts.verified, 0);
  assert.equal(result.counts.unverified, 2);
});

test('إحداثي «(1,3)» ترقيم لا رقم مستقل', () => {
  const result = judgeNumbers([page({ summary: 'الفترة المفتوحة (1,3) تمثّل على خط الأعداد' })]);
  assert.equal(result.counts.unverified, 0);
  assert.equal(result.counts.structural, 1);
});

test('الدليل البصري المسجّل في verifiedNumbers يُغني عن سند النص', () => {
  const result = judgeNumbers([page({ summary: 'طول القناة 64 كم', verifiedNumbers: ['64'] })]);
  assert.equal(result.counts.unverified, 0);
  assert.equal(result.items[0].via, 'verifiedNumbers');
});

test('ترقيم بنيوي لا يُعد اختراقاً', () => {
  const result = judgeNumbers([page({ title: '(3-10) تطبيقات على النهايات', summary: 'الفصل 12: الاشتقاق' })]);
  assert.equal(result.counts.structural, 2);
  assert.equal(result.counts.unverified, 0);
});

test('الرقم غير المُثبت يحمل اسم سلامة الصفحة', () => {
  const result = judgeNumbers([page({ summary: 'انتفاضة عام 1909', text: `${longText} 20 ` })]);
  assert.equal(result.unverified.length, 1);
  assert.equal(result.unverified[0].verdict, 'unverified');
  assert.equal(result.unverified[0].integrity, 'intact');
});

test('عنوان الكتاب في كل صفحة فجوة استرجاع مستقلة', () => {
  const docs = Array.from({ length: 10 }, (_, index) => page({ physicalPage: index + 1, title: index < 6 ? 'النحو الواضح في قواعد اللغة العربية' : `درس ${index}` }));
  const result = titleRepetition(docs, 'النحو الواضح في قواعد اللغة العربية');
  assert.equal(result.bookTitlePages.length, 6);
  assert.equal(result.bookTitleShare, 0.6);
});

test('تكرار العنوان الذي ليس عنوان الكتاب يبقى تكراراً لا استرجاعاً', () => {
  const docs = [
    ...Array.from({ length: 4 }, (_, index) => page({ physicalPage: index + 1, title: 'درس المقدمة' })),
    ...Array.from({ length: 4 }, (_, index) => page({ physicalPage: index + 5, title: `درس ${index}` })),
  ];
  const result = titleRepetition(docs, 'النحو الواضح في قواعد اللغة العربية');
  assert.equal(result.bookTitlePages.length, 0);
  assert.equal(result.boilerplate[0].count, 4);
});

test('اسم الوحدة الإنكليزي يثبت من نص الصفحة الإنكليزي', () => {
  const docs = [page({ unit: 'Literature Focus — Pride and Prejudice', text: 'Literature Focus: Pride and Prejudice. Chapter 1 The novel begins in '.repeat(6) })];
  const owners = new Map([['Literature Focus — Pride and Prejudice', new Set(['a', 'b'])]]);
  assert.equal(foreignUnits(docs, owners, 'a').length, 0);
});

test('اسم وحدة لا يثبته نص الصفحة يُبلَّغ عنه', () => {
  const docs = [page({ unit: 'Literature Focus — Pride and Prejudice', text: 'Exercise 3: translate the sentences into Arabic language carefully '.repeat(6) })];
  const owners = new Map([['Literature Focus — Pride and Prejudice', new Set(['a', 'b'])]]);
  const result = foreignUnits(docs, owners, 'a');
  assert.equal(result.length, 1);
  assert.equal(result[0].alsoIn, 'b');
  assert.ok(result[0].proven < 80);
});

test('صفحة بلا نص تحمل وصفاً تُبلَّغ بصفتها', () => {
  const result = noTextPages([page({ text: '', title: 'تفسير خاتمة سورة الكهف', needsOcr: true }), page({ text: longText })]);
  assert.equal(result.empty.length, 1);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].needsOcr, true);
  assert.equal(result.share, 0.5);
});

test('الطبقة التي لا يقرأها كود تُعد ميتة', () => {
  const layers = [
    { layer: 'fast-index.json', exists: true, bytes: 3_100_000, olderByHours: 170, readers: [] },
    { layer: 'index/search-index.json', exists: true, bytes: 4_100_000, olderByHours: 187, readers: ['lib/index.mjs'] },
    { layer: 'catalog.json', exists: false, bytes: 0, olderByHours: null, readers: [] },
  ];
  const dead = deadLayers(layers);
  assert.equal(dead.length, 1);
  assert.equal(dead[0].layer, 'fast-index.json');
});

test('تكرار حرفي بين كتابين يُكتشف مع الإزاحة', () => {
  const shared = 'Unit 1 Reading comprehension exercises for sixth grade students '.repeat(8);
  const docsByBook = new Map([
    ['a', [2, 3, 4].map((physicalPage) => page({ physicalPage, text: shared }))],
    ['b', [40, 41, 42].map((physicalPage) => page({ physicalPage, text: shared }))],
    ['c', [page({ physicalPage: 5, text: `${shared} تمرين خاص بالكتاب الثالث فقط ` })]],
  ]);
  const result = crossBookDuplicates(docsByBook);
  assert.equal(result.length, 1);
  assert.equal(result[0].left, 'a');
  assert.equal(result[0].right, 'b');
  assert.equal(result[0].shared, 3);
  assert.equal(result[0].offset, 38);
});