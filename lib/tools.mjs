// Small, read-only curriculum tools. The model chooses all scopes and actions.
import { getBookPages, getCatalog, fullPage, listBooks, searchCandidates } from './index.mjs';
import { readOutlineSource } from './outline.mjs';
import { readPdfPage } from './pdf-fallback.mjs';

const integer = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const offsetOf = (value) => Math.max(0, Math.floor(Number(value) || 0));
const limitOf = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const ok = (data, meta = {}, image) => ({ ok: true, content: typeof data === 'string' ? data : JSON.stringify(data), meta, ...(image ? { image } : {}) });
const fail = (error, content, meta = {}) => ({ ok: false, error, content: typeof content === 'string' ? content : JSON.stringify(content), meta });
const idProperty = { type: 'string', description: 'معرّف الكتاب من قائمة الكتب.' };
const paging = {
  offset: { type: 'integer', description: 'موضع البداية من صفر؛ nextOffset لاستكمال الدفعة.' },
  limit: { type: 'integer', description: 'عدد العناصر في الدفعة؛ النصوص داخل كل عنصر كاملة.' },
};
const pageProperties = {
  bookId: idProperty,
  printedPage: { type: 'integer', description: 'رقم الصفحة المطبوع حسب الخريطة المخزّنة؛ ليس تحققاً بصرياً.' },
  physicalPage: { type: 'integer', description: 'صفحة PDF الفيزيائية، تبدأ من 1؛ لا تساوي المطبوع بالضرورة.' },
};
const tool = (name, description, properties, required = []) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties, required },
} });
export const TOOLS = [
  tool('list_books', 'الكتب المتاحة ومصادرها؛ الفلاتر اختيارية.', {
    subject: { type: 'string' }, track: { type: 'string' },
  }),
  tool('get_book', 'بيانات كتاب وخريطة صفحاته؛ nextOffset لاستكمال الخريطة.', { bookId: idProperty, ...paging }, ['bookId']),
  tool('search_books', 'بحث في النص المخزّن والفهرس؛ matchedIn يذكر الحقول. ترتيب ثابت بلا ترتيب صلة؛ nextOffset للبقية.', {
    query: { type: 'string' }, bookId: idProperty, subject: { type: 'string' }, track: { type: 'string' },
    match: { type: 'string', enum: ['any', 'all', 'phrase'], description: 'any لأي كلمة؛ all لكل الكلمات؛ phrase لعبارة متصلة. مطابقة جزئية مع تطبيع معلن بلا حذف كلمات أو اشتقاق.' },
    ...paging,
  }, ['query']),
  tool('read_page', 'نص صفحة مخزّن كامل بلا تصحيح؛ مرّري رقم PDF أو المطبوع. حالات النص والترقيم ليست ضماناً بصرياً.', pageProperties, ['bookId']),
  tool('read_pdf_page', 'صفحة PDF الأصلية: نص هندسي والنص المخزّن معاً؛ wantImage للصورة وrawItems لعناصر النص الأصلية. الفشل معلن.', {
    ...pageProperties, wantImage: { type: 'boolean' }, rawItems: { type: 'boolean', description: 'عناصر النص وإحداثياتها وترتيبها الأصلي للمقارنة.' },
  }, ['bookId']),
  tool('read_pages_range', 'نطاق صفحات مخزّنة كامل النص؛ نطاق مطبوع أو فيزيائي، لا كليهما. nextOffset للبقية.', {
    bookId: idProperty, printedFrom: { type: 'integer' }, printedTo: { type: 'integer' },
    physicalFrom: { type: 'integer' }, physicalTo: { type: 'integer' }, ...paging,
  }, ['bookId']),
  tool('get_outline', 'ملف الفهرس المخزّن كما هو؛ ليس نص الكتاب. nextOffset لاستكمال الأسطر.', { bookId: idProperty, ...paging }, ['bookId']),
  tool('get_page_neighbors', 'الصفحة السابقة والحالية والتالية داخل PDF؛ نصوص مخزّنة كاملة.', pageProperties, ['bookId']),
];
export const TOOL_NAMES = new Set(TOOLS.map((entry) => entry.function.name));

const citationOf = (book, page) => ({
  id: `${page.bookId}-PDF${page.physicalPage}`, bookId: page.bookId, title: book?.title || page.bookId,
  subject: book?.subject || '', track: book?.track || book?.branch || '',
  physicalPage: page.physicalPage, printedPage: page.printedPage ?? null, pageTitle: page.title,
  sourceType: 'curriculum', evidenceType: page.evidenceType, evidenceStatus: page.evidenceStatus || page.status,
  searchable: Boolean(page.text), quotableReliable: false, damaged: page.status === 'damaged-text',
  visionProvided: Boolean(page.imageDataUrl), readable: Boolean(page.text || page.imageDataUrl),
});
function pageData(page) {
  // fullText/quotableText are aliases of text, not different evidence; transmit once.
  const { fullText, quotableText, textItems, styles, imageDataUrl, ...data } = page;
  return data;
}
async function resolvePage(bookId, args) {
  const pages = await getBookPages(bookId);
  const physical = integer(args.physicalPage);
  const printed = integer(args.printedPage);
  if (physical == null && printed == null) throw Object.assign(new Error('مرّري رقم صفحة PDF أو المطبوع.'), { code: 'PAGE_REQUIRED' });
  const matches = physical != null ? pages.filter((page) => page.physicalPage === physical) : pages.filter((page) => page.printedPage === printed);
  if (matches.length > 1) throw Object.assign(new Error(JSON.stringify(matches)), { code: 'AMBIGUOUS_PRINTED_PAGE' });
  if (!matches.length) throw Object.assign(new Error('لا يوجد ربط للصفحة المطلوبة في خريطة الكتاب.'), { code: 'PAGE_NOT_FOUND' });
  if (printed != null && matches[0].printedPage !== printed) throw Object.assign(new Error(JSON.stringify({ requested: args, mapped: matches[0] })), { code: 'PAGE_NUMBER_CONFLICT' });
  return matches[0].physicalPage;
}
function batch(items, args, defaultLimit) {
  const offset = offsetOf(args.offset), limit = limitOf(args.limit, defaultLimit);
  const selected = items.slice(offset, offset + limit);
  return { selected, total: items.length, offset, limit, returned: selected.length,
    nextOffset: offset + selected.length < items.length ? offset + selected.length : null };
}

export async function executeTool(name, args = {}, ctx = {}) {
  try {
    ctx.signal?.throwIfAborted();
    if (args.parseError) return fail('INVALID_TOOL_ARGUMENTS', args.parseError);
    if (!TOOL_NAMES.has(name)) return fail('UNKNOWN_TOOL', `اسم الأداة غير معروف: ${name}`);
    if (name === 'list_books') {
      const catalog = await getCatalog({ track: args.track || '' });
      const books = args.subject ? await listBooks({ track: args.track || '', subject: args.subject }) : catalog.books;
      return ok({ total: books.length, books }, { returned: books.length });
    }
    if (name === 'search_books') {
      if (typeof args.query !== 'string' || !args.query.trim()) return fail('EMPTY_QUERY', 'عبارة البحث فارغة.');
      const result = await searchCandidates(args.query, { ...args, limit: limitOf(args.limit, 8) });
      const books = new Map((await listBooks()).map((book) => [book.id, book]));
      const citations = result.results.map((page) => citationOf(books.get(page.bookId), page));
      return ok({ ...result, results: result.results.map(pageData) }, {
        total: result.total, returned: result.results.length, offset: result.offset, nextOffset: result.nextOffset, citations,
      });
    }
    const bookId = String(args.bookId || '');
    if (!/^[a-z0-9][a-z0-9-]{1,80}$/i.test(bookId)) return fail('INVALID_BOOK_ID', 'معرّف الكتاب غير صالح.');
    const book = (await listBooks()).find((entry) => entry.id === bookId);
    if (!book) return fail('BOOK_NOT_FOUND', `لا يوجد كتاب بمعرّف ${bookId}.`);
    if (name === 'get_book') {
      const { selected: pages, ...meta } = batch(await getBookPages(bookId), args, 100);
      return ok({ book, ...meta, pages }, { ...meta, bookId });
    }
    if (name === 'get_outline') {
      const raw = await readOutlineSource(bookId);
      if (raw == null) return fail('OUTLINE_NOT_FOUND', `لا يوجد فهرس مخزّن للكتاب ${bookId}.`);
      const { selected: lines, ...meta } = batch(raw.split(/\r?\n/), args, 120);
      return ok({ bookId, kind: 'stored-outline-not-page-text', ...meta, lines }, meta);
    }
    if (name === 'read_pdf_page') {
      const physicalPage = await resolvePage(bookId, args);
      const page = await readPdfPage({ bookId, physicalPage, forceSource: true, signal: ctx.signal,
        wantImage: args.wantImage === true && ctx.sendImage !== false, rawItems: args.rawItems === true });
      const image = page.imageDataUrl || '';
      const data = { ...pageData(page), ...(args.rawItems ? { textItems: page.textItems, styles: page.styles } : {}),
        imageProvided: Boolean(image), imageSupported: ctx.sendImage !== false,
        notice: 'text مستخرج هندسياً من PDF؛ storedText نسخة مخزّنة منفصلة. لا نسخة تختار بدل الأخرى. الصورة الأصل للتحقق من النص والترقيم.' };
      const meta = { page: data };
      if (!page.pdfOpened) return fail('PDF_SOURCE_UNAVAILABLE', data, meta);
      if (args.wantImage && !image) return fail('PDF_IMAGE_UNAVAILABLE', data, meta);
      return ok(data, { ...meta, citation: citationOf(book, page) }, image);
    }
    if (name === 'read_page') {
      const page = pageData(await fullPage(bookId, await resolvePage(bookId, args)));
      return ok(page, { page, citation: citationOf(book, page) });
    }
    let selected, pagingMeta, missingRanges = [];
    if (name === 'get_page_neighbors') {
      const physical = await resolvePage(bookId, args);
      selected = (await getBookPages(bookId)).filter((page) => Math.abs(page.physicalPage - physical) <= 1);
      pagingMeta = { currentPhysical: physical, nextOffset: null, returned: selected.length };
    } else {
      const physical = args.physicalFrom != null || args.physicalTo != null;
      if (physical && (args.printedFrom != null || args.printedTo != null)) return fail('AMBIGUOUS_PAGE_RANGE', 'حددا نطاقاً مطبوعاً أو فيزيائياً لا كليهما.');
      const from = integer(physical ? args.physicalFrom : args.printedFrom);
      const to = integer(physical ? args.physicalTo : args.printedTo);
      if (from == null || to == null || to < from) return fail('INVALID_PAGE_RANGE', 'نطاق الصفحات غير صالح.');
      const numberOf = (page) => physical ? page.physicalPage : page.printedPage;
      const all = (await getBookPages(bookId)).filter((page) => numberOf(page) != null && numberOf(page) >= from && numberOf(page) <= to)
        .sort((a, b) => numberOf(a) - numberOf(b) || a.physicalPage - b.physicalPage);
      let cursor = from;
      for (const number of new Set(all.map(numberOf))) {
        if (number > cursor) missingRanges.push({ from: cursor, to: number - 1 });
        cursor = number + 1;
      }
      if (cursor <= to) missingRanges.push({ from: cursor, to });
      const { selected: entries, ...meta } = batch(all, args, 8);
      selected = entries;
      pagingMeta = { ...meta, numbering: physical ? 'physical' : 'printed', from, to };
    }
    const pages = await Promise.all(selected.map(async (entry) => {
      try { return pageData(await fullPage(bookId, entry.physicalPage)); }
      catch (error) { return { ...entry, error: error.code || error.message }; }
    }));
    const citations = pages.filter((page) => !page.error).map((page) => citationOf(book, page));
    return ok({ bookId, ...pagingMeta, missingRanges, pages }, {
      ...pagingMeta, missingRanges, citations, opened: citations.length, missing: pages.length - citations.length,
    });
  } catch (error) {
    return fail(error.code || 'TOOL_EXECUTION_FAILED', String(error.message || error));
  }
}
