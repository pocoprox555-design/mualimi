// The model selects tools and arguments; this module executes them and returns their data.
import { getBookPages, getCatalog, fullPage, listBooks, searchCandidates } from './index.mjs';
import { readOutlineSource } from './outline.mjs';
import { readPdfPage } from './pdf-fallback.mjs';

const BOOK_ID = /^[a-z0-9][a-z0-9-]{1,80}$/i;
const SAFE_IMAGE = /^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i;

const asText = (value) => String(value ?? '').trim();
const asPage = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};
const asOffset = (value) => Math.max(0, Math.floor(Number(value) || 0));
const asLimit = (value, fallback) => Math.max(1, Math.floor(Number(value) || fallback));
const asBoolean = (value) => value === true;

function validBookId(value) {
  const bookId = asText(value);
  return BOOK_ID.test(bookId) ? bookId : '';
}

async function physicalPageFor(bookId, printedPage) {
  const matches = (await getBookPages(bookId))
    .filter((page) => page.printedPage === printedPage)
    .map((page) => ({ physicalPage: page.physicalPage, title: page.title }))
    .sort((a, b) => a.physicalPage - b.physicalPage);
  if (matches.length > 1) return { ambiguous: true, matches };
  return { physicalPage: matches[0]?.physicalPage ?? null, matches };
}

function success(content, meta = {}, image) {
  return { ok: true, content: String(content ?? ''), meta, ...(image ? { image } : {}) };
}

function failure(code, content, meta = {}) {
  return { ok: false, error: String(code || 'TOOL_FAILED'), content: String(content || code || 'Tool failed.'), meta: { error: String(code || 'TOOL_FAILED'), ...meta } };
}

function pageLabel(page) {
  const physical = page?.physicalPage == null ? 'غير محددة' : `PDF ${page.physicalPage}`;
  const printed = page?.printedPage == null ? 'غير متحقق' : `مطبوعة ${page.printedPage}`;
  return `صفحة ${printed} (${physical})`;
}

function citationOf(book, page, sourceType = 'curriculum') {
  return {
    id: `${page?.bookId || book?.id || 'book'}-PDF${page?.physicalPage ?? 'x'}`,
    sourceType,
    bookId: page?.bookId || book?.id || '',
    title: book?.title || page?.bookId || '',
    subject: book?.subject || '',
    track: book?.track || book?.branch || '',
    physicalPage: page?.physicalPage ?? null,
    printedPage: page?.printedPage ?? null,
    pageTitle: page?.title || '',
    evidenceType: page?.evidenceType || (page?.quotableReliable ? 'pdf-text' : 'outline-description'),
    evidenceStatus: page?.evidenceStatus || page?.status || 'unverified',
    searchable: Boolean(page?.searchable),
    quotableReliable: Boolean(page?.quotableReliable),
    damaged: Boolean(page?.damaged),
    visionProvided: Boolean(page?.visionProvided),
    readable: Boolean(page?.searchable || page?.text || page?.imageDataUrl),
  };
}

function pageEvidence(page) {
  if (page?.evidenceStatus === 'damaged-text') {
    return 'النص المستخرج موسوم بالتلف. النص أدناه نتيجة استخراج غير موثوقة حرفياً؛ قارنيه بصفحة PDF الأصلية قبل الاقتباس.';
  }
  if (!page?.searchable && !page?.text) {
    return 'لا يتوفر نص مستخرج لهذه الصفحة. الوصف الفهرسي - إن وجد - ليس نصاً حرفياً من الكتاب.';
  }
  if (page?.evidenceStatus === 'ocr-text') {
    return 'النص مستخرج بالـOCR. تحققي من الأرقام والمواضع بصرياً قبل الاقتباس الحرفي.';
  }
  if (page?.quotableReliable) return 'النص المستخرج متاح وحالة الفهرس تصفه بأنه صالح للاقتباس.';
  return 'النص متاح لكن الفهرس لا يصفه بأنه موثوق للاقتباس الحرفي.';
}

function pageContent(book, page) {
  const text = String(page?.text || '');
  const quotable = String(page?.quotableText || '');
  const fields = [
    `الكتاب: ${book?.title || page?.bookId || 'غير معروف'} (${page?.bookId || 'بدون معرّف'})`,
    `المادة: ${book?.subject || 'غير محددة'}`,
    pageLabel(page),
    `حالة الدليل: ${page?.evidenceStatus || 'غير متحقق'}; searchable=${Boolean(page?.searchable)}; quotableReliable=${Boolean(page?.quotableReliable)}`,
    pageEvidence(page),
    page?.damageReasons?.length ? `أسباب التلف المسجلة: ${page.damageReasons.join('؛ ')}` : '',
    page?.visionReasons?.length ? `ملاحظات القراءة البصرية: ${page.visionReasons.join('؛ ')}` : '',
    `العنوان: ${page?.title || 'غير متوفر'}${page?.section ? `؛ القسم: ${page.section}` : ''}${page?.unit ? `؛ الوحدة: ${page.unit}` : ''}`,
    'النص الكامل المتاح في فهرس الصفحات:',
    text || '(لا يوجد نص مستخرج لهذه الصفحة.)',
    quotable && quotable !== text ? `\nنسخة النص المقترحة للاقتباس (${page?.quotableSource || 'غير معروف'}):\n${quotable}` : '',
    page?.outlineSummary ? `\nوصف الفهرس غير الحرفي:\n${page.outlineSummary}` : '',
    page?.notes ? `\nملاحظات بيانات الصفحة:\n${typeof page.notes === 'string' ? page.notes : JSON.stringify(page.notes)}` : '',
    `البيانات المنظّمة كما حُفظت في الفهرس: ${JSON.stringify(Object.fromEntries(Object.entries(page || {}).filter(([key, value]) => ['glossary', 'glossaryRefs', 'vocabulary', 'figures', 'activities', 'exercises', 'answerKeyLocation', 'continuesOn', 'recapOf'].includes(key) && value != null)))}`,
  ];
  return fields.filter(Boolean).join('\n');
}

const pageProperties = {
  bookId: { type: 'string', description: 'معرّف الكتاب كما يظهر في list_books أو نتيجة البحث.' },
  printedPage: { type: 'integer', description: 'رقم الصفحة المطبوع في الكتاب. قد يختلف عن رقم صفحة PDF.' },
  physicalPage: { type: 'integer', description: 'رقم الصفحة الفيزيائية داخل ملف PDF.' },
};

const functionTool = (name, description, properties, required = []) => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
  },
});

export const TOOLS = [
  functionTool(
    'list_books',
    'اعرضي بيانات الكتب المتاحة. لا تختاري كتاباً نيابةً عن الطالبة؛ اقرئي القائمة وحددي ما يلائم سياق المحادثة أو اطلبي توضيحاً.',
    {
      subject: { type: 'string', description: 'فلتر مادة اختياري، إذا قررتِ أنتِ تضييق القائمة.' },
      track: { type: 'string', description: 'فلتر مسار اختياري، إذا قررتِ أنتِ تضييق القائمة.' },
    },
  ),
  functionTool(
    'get_book',
    'أحضري بيانات كتاب محدد وخريطة صفحاته: أرقام الصفحات المطبوعة والفيزيائية وحالة النص. استخدمي offset/limit لتصفح الخرائط الطويلة وnextOffset لمتابعة الدفعات.',
    {
      bookId: pageProperties.bookId,
      offset: { type: 'integer', description: 'موضع أول صفحة في الدفعة، بدءاً من صفر.' },
      limit: { type: 'integer', description: 'عدد الصفحات في الدفعة؛ الافتراضي 100. استخدمي nextOffset للتتمة.' },
    },
    ['bookId'],
  ),
  functionTool(
    'search_books',
    'ابحثي نصياً في فهرس الصفحات. النتائج هي كل الصفحات المطابقة لمصطلحات البحث في مرشّح هذه الدفعة، مرتبة حسب معرّف الكتاب ورقم PDF لا حسب قرار تربوي. تعيد كل نتيجة النص الكامل المتاح وحالة الدليل؛ إذا أعادت nextOffset فاستدعي الأداة مجدداً بهذا المؤشر لتصفحي بقية النتائج.',
    {
      query: { type: 'string', description: 'عبارة أو كلمات تبحثين عنها كما تفهمينها من السؤال والسياق.' },
      bookId: { type: 'string', description: 'معرّف كتاب اختياري اختَرته أنتِ من قائمة الكتب.' },
      subject: { type: 'string', description: 'مادة اختيارية اختَرْتِها أنتِ من قائمة الكتب.' },
      track: { type: 'string', description: 'مسار اختياري اختَرْتِه أنتِ من قائمة الكتب.' },
      offset: { type: 'integer', description: 'ابدئي من هذا الموضع في النتائج، واستخدمي nextOffset لاستكمالها.' },
      limit: { type: 'integer', description: 'عدد النتائج في هذه الدفعة؛ الافتراضي 8. غيّريه حسب حاجة السؤال والسياق.' },
    },
    ['query'],
  ),
  functionTool(
    'read_page',
    'اقرئي صفحة محددة من فهرس المنهج. أعيدي النص المتاح كاملاً مع حالة الدليل والبيانات المنظّمة. رقم المطبوعة ورقم PDF منفصلان؛ مرّري واحداً منهما على الأقل.',
    pageProperties,
    ['bookId'],
  ),
  functionTool(
    'read_pdf_page',
    'افتحي صفحة ملف PDF الأصلي، لا نسخة الفهرس فقط. أرسلي صورة الصفحة إذا طلبتِها وكان نموذجك يدعم الصور. تعيد حالة فتح الأصل وأي نص/صورة/خطأ متاح بوضوح.',
    {
      ...pageProperties,
      wantImage: { type: 'boolean', description: 'اطلبي رسم صورة الصفحة للتحقق بصرياً. لا تضعي true إلا إذا كان نموذجك يقبل الصور.' },
    },
    ['bookId'],
  ),
  functionTool(
    'read_pages_range',
    'اقرئي الصفحات المفهرسة ضمن نطاق مطبوع تختارينه. تعيد الأداة دفعة قابلة للاستمرار؛ إذا ظهر nextOffset فاستدعيها مجدداً بالقيم نفسها وoffset المعاد حتى تصلي إلى كل الصفحات المطلوبة. كل نص صفحة في الدفعة كامل.',
    {
      bookId: pageProperties.bookId,
      printedFrom: { type: 'integer', description: 'أول رقم صفحة مطبوع.' },
      printedTo: { type: 'integer', description: 'آخر رقم صفحة مطبوع، شاملاً الحد.' },
      offset: { type: 'integer', description: 'موضع الصفحة الأولى داخل صفحات النطاق، بدءاً من صفر.' },
      limit: { type: 'integer', description: 'عدد الصفحات في الدفعة؛ الافتراضي 8. لا يوجد سقف ثابت؛ استخدمي nextOffset للتتمة.' },
    },
    ['bookId', 'printedFrom', 'printedTo'],
  ),
  functionTool(
    'get_outline',
    'تصفحي ملف الفهرس الخام للكتاب كما هو. هذا مخطط مساعد وليس نصاً حرفياً من صفحات PDF؛ استخدمي read_page للتحقق من محتوى الدرس. استخدمي offset/limit لمتابعة الملف الطويل.',
    {
      bookId: pageProperties.bookId,
      offset: { type: 'integer', description: 'موضع السطر الأول للدفعة، بدءاً من صفر.' },
      limit: { type: 'integer', description: 'عدد الأسطر؛ الافتراضي 120. استخدمي nextOffset للتتمة.' },
    },
    ['bookId'],
  ),
  functionTool(
    'get_page_neighbors',
    'اقرئي الصفحة السابقة والتالية داخل ملف PDF الفيزيائي للصفحة المطلوبة. تعيد النص الكامل المتاح لكل صفحة مع أرقامها المطبوعة والفيزيائية؛ إن كان المقصود رقماً مطبوعاً فمرّريه.',
    pageProperties,
    ['bookId'],
  ),
];

export const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.function.name));

export async function executeTool(name, args = {}, ctx = {}) {
  if (args?.parseError) return failure('INVALID_TOOL_ARGUMENTS', `وسائط الأداة لم تكن JSON صالحاً: ${args.parseError}`);
  try {
    switch (name) {
      case 'list_books': {
        const catalog = await getCatalog({ track: asText(args.track) });
        const wantedSubject = asText(args.subject);
        const books = wantedSubject
          ? catalog.books.filter((book) => `${book.title} ${book.subject}`.includes(wantedSubject))
          : catalog.books;
        return success(JSON.stringify({ total: books.length, books }), { total: books.length });
      }
      case 'get_book': {
        const bookId = validBookId(args.bookId);
        if (!bookId) return failure('INVALID_BOOK_ID', 'معرّف الكتاب مطلوب وصيغته غير صالحة.');
        const book = (await listBooks()).find((entry) => entry.id === bookId);
        if (!book) return failure('BOOK_NOT_FOUND', `لا يوجد كتاب بمعرّف ${bookId}.`);
        const allPages = await getBookPages(bookId);
        const offset = asOffset(args.offset);
        const limit = asLimit(args.limit, 100);
        const pages = allPages.slice(offset, offset + limit);
        const nextOffset = offset + pages.length < allPages.length ? offset + pages.length : null;
        return success(JSON.stringify({ book, totalPages: allPages.length, offset, nextOffset, pages }), {
          bookId, totalPages: allPages.length, returned: pages.length, offset, nextOffset,
        });
      }
      case 'search_books': {
        const query = asText(args.query);
        if (!query) return failure('EMPTY_QUERY', 'عبارة البحث فارغة؛ أرسلي مصطلحاً من سؤال الطالبة.');
        const bookId = args.bookId ? validBookId(args.bookId) : '';
        if (args.bookId && !bookId) return failure('INVALID_BOOK_ID', 'معرّف الكتاب غير صالح.');
        const result = await searchCandidates(query, {
          bookId,
          subject: asText(args.subject),
          track: asText(args.track),
          offset: asOffset(args.offset),
          limit: asLimit(args.limit, 8),
        });
        const books = await listBooks();
        const byId = new Map(books.map((book) => [book.id, book]));
        const citations = result.results.map((page) => citationOf(byId.get(page.bookId), {
          ...page,
          evidenceType: page.evidenceStatus === 'damaged-text' ? 'damaged-text' : page.searchable ? 'pdf-text' : 'outline-description',
          quotableReliable: page.evidenceStatus === 'clean-extracted-text' || page.evidenceStatus === 'ocr-text',
        }));
        return success(JSON.stringify(result), {
          citations,
          total: result.total,
          offset: result.offset,
          nextOffset: result.nextOffset,
          returned: result.results.length,
        });
      }
      case 'read_page': {
        const bookId = validBookId(args.bookId);
        if (!bookId) return failure('INVALID_BOOK_ID', 'معرّف الكتاب مطلوب وصيغته غير صالحة.');
        const physicalPage = asPage(args.physicalPage);
        const printedPage = asPage(args.printedPage);
        if (physicalPage == null && printedPage == null) return failure('PAGE_REQUIRED', 'مرّري رقم صفحة مطبوع أو رقم صفحة PDF.');
        let physical = physicalPage;
        if (physical == null) {
          const located = await physicalPageFor(bookId, printedPage);
          if (located.ambiguous) return failure('AMBIGUOUS_PRINTED_PAGE', `الصفحة المطبوعة ${printedPage} تقابل أكثر من صفحة PDF. حددي physicalPage من هذه الخيارات: ${JSON.stringify(located.matches)}`, { candidates: located.matches });
          physical = located.physicalPage;
        }
        if (physical == null) return failure('PAGE_NOT_FOUND', `لم يعثر فهرس الكتاب ${bookId} على الصفحة المطبوعة ${printedPage}.`);
        const page = await fullPage(bookId, physical);
        const book = (await listBooks()).find((entry) => entry.id === bookId);
        const citation = citationOf(book, page);
        return success(pageContent(book, page), { citation, page: { ...page } });
      }
      case 'read_pdf_page': {
        const bookId = validBookId(args.bookId);
        if (!bookId) return failure('INVALID_BOOK_ID', 'معرّف الكتاب مطلوب وصيغته غير صالحة.');
        const physicalPage = asPage(args.physicalPage);
        const printedPage = asPage(args.printedPage);
        if (physicalPage == null && printedPage == null) return failure('PAGE_REQUIRED', 'مرّري رقم صفحة مطبوع أو رقم صفحة PDF.');
        const wantsImage = asBoolean(args.wantImage);
        const canSendImage = wantsImage && ctx.sendImage !== false;
        let resolvedPhysical = physicalPage;
        if (resolvedPhysical == null) {
          const located = await physicalPageFor(bookId, printedPage);
          if (located.ambiguous) return failure('AMBIGUOUS_PRINTED_PAGE', `الصفحة المطبوعة ${printedPage} تقابل أكثر من صفحة PDF. حددي physicalPage من هذه الخيارات: ${JSON.stringify(located.matches)}`, { candidates: located.matches });
          resolvedPhysical = located.physicalPage;
        }
        if (resolvedPhysical == null) return failure('PAGE_NOT_FOUND', `لم يعثر فهرس الكتاب ${bookId} على الصفحة المطبوعة ${printedPage}.`);
        const page = await readPdfPage({
          bookId,
          physicalPage: resolvedPhysical,
          printedPage: printedPage ?? undefined,
          forceSource: true,
          signal: ctx.signal,
          wantImage: canSendImage,
        });
        const book = (await listBooks()).find((entry) => entry.id === bookId);
        const image = typeof page.imageDataUrl === 'string' && SAFE_IMAGE.test(page.imageDataUrl) ? page.imageDataUrl : '';
        const sourceNote = page.pdfOpened
          ? `الأصل: فُتح ملف PDF فعلياً (المستند المفتوح من الذاكرة: ${Boolean(page.fromCache)}؛ نص الصفحة من الذاكرة: ${Boolean(page.pageTextCacheHit)}).`
          : `الأصل: لم يثبت فتح ملف PDF؛ مصدر النص هو ${page.textSource || 'غير متاح'}، وحالة فتح المصدر ${page.sourceProvenance?.sourceStatus || page.status || 'غير معروفة'}.`;
        const imageNote = image
          ? 'أُرسلت صورة الصفحة للنموذج.'
          : wantsImage && !canSendImage
            ? 'طُلبت الصورة لكن النموذج أو إعداد الطلب لا يسمح بإرسال صور؛ لا توجد معاينة بصرية في هذه النتيجة.'
            : page.imageError
              ? `فشل إنشاء صورة الصفحة: ${page.imageError}`
              : 'لم تُنشأ صورة لهذه الصفحة.';
        const content = [
          `الكتاب: ${book?.title || bookId} (${bookId})`,
          pageLabel(page),
          `حالة المصدر: ${page.status || 'غير متحقق'}; textSource=${page.textSource || 'none'}; pdfOpened=${Boolean(page.pdfOpened)}`,
          sourceNote,
          imageNote,
          page.text || '(لم يُستخرج نص من الصفحة الأصلية.)',
          page.error ? `تفصيل الخطأ: ${page.error}` : '',
        ].filter(Boolean).join('\n');
        const citation = citationOf(book, {
          ...page,
          evidenceStatus: page.status,
          evidenceType: page.evidenceType,
          searchable: Boolean(page.text),
          quotableReliable: ['clean-extracted-text', 'ocr-text'].includes(page.status) && Boolean(page.text),
          visionProvided: Boolean(image),
        }, 'pdf-fallback');
        return success(content, { citation, page: { ...page, imageDataUrl: undefined } }, image);
      }
      case 'read_pages_range': {
        const bookId = validBookId(args.bookId);
        const from = asPage(args.printedFrom);
        const to = asPage(args.printedTo);
        if (!bookId) return failure('INVALID_BOOK_ID', 'معرّف الكتاب مطلوب وصيغته غير صالحة.');
        if (from == null || to == null || to < from) return failure('INVALID_PAGE_RANGE', 'حددا نطاقاً صحيحاً من رقم صفحة مطبوع أول إلى آخر.');
        const book = (await listBooks()).find((entry) => entry.id === bookId);
        if (!book) return failure('BOOK_NOT_FOUND', `لا يوجد كتاب بمعرّف ${bookId}.`);
        const span = to - from + 1;
        const bookPages = await getBookPages(bookId);
        const allPages = bookPages
          .filter((page) => page.printedPage != null && page.printedPage >= from && page.printedPage <= to)
          .sort((a, b) => a.printedPage - b.printedPage || a.physicalPage - b.physicalPage);
        const offset = asOffset(args.offset);
        const limit = asLimit(args.limit, 8);
        const pages = allPages.slice(offset, offset + limit);
        const nextOffset = offset + pages.length < allPages.length ? offset + pages.length : null;
        const printedNumbers = [...new Set(allPages.map((page) => page.printedPage))];
        const missingRanges = [];
        let cursor = from;
        for (const printed of printedNumbers) {
          if (printed > cursor) missingRanges.push({ from: cursor, to: printed - 1 });
          cursor = Math.max(cursor, printed + 1);
        }
        if (cursor <= to) missingRanges.push({ from: cursor, to });

        const chunks = [];
        const citations = [];
        let opened = 0;
        let missing = 0;
        for (const entry of pages) {
          try {
            const page = await fullPage(bookId, entry.physicalPage);
            opened += 1;
            citations.push(citationOf(book, page));
            chunks.push(pageContent(book, page));
          } catch (error) {
            missing += 1;
            chunks.push(`=== الصفحة المطبوعة ${entry.printedPage} (PDF ${entry.physicalPage}): تعذرت قراءتها: ${String(error?.message || error)} ===`);
          }
        }
        const missingCount = missingRanges.reduce((total, range) => total + range.to - range.from + 1, 0) + missing;
        const gaps = missingRanges.length
          ? `الأرقام المطبوعة التي لا يظهر لها ربط في الفهرس: ${missingRanges.map((range) => range.from === range.to ? range.from : `${range.from}–${range.to}`).join('، ')}`
          : 'كل الأرقام المطبوعة في النطاق لها صفحات مفهرسة.';
        const continuation = nextOffset == null ? 'اكتملت صفحات النطاق المفهرسة.' : `بقيت صفحات في النطاق؛ استدعي الأداة مجدداً مع offset=${nextOffset}.`;
        return success(`النطاق المطلوب ${from}–${to} (${span} رقماً مطبوعاً)؛ في هذه الدفعة قُرئت ${opened} صفحة وتعذرت قراءة ${missing}. عدد صفحات النطاق المفهرسة ${allPages.length}. ${continuation} ${gaps}\n\n${chunks.join('\n\n')}`, {
          bookId, printedFrom: from, printedTo: to, span, totalPages: allPages.length, offset, nextOffset, opened, missing, missingNumbers: missingCount, missingRanges, citations,
        });
      }
      case 'get_outline': {
        const bookId = validBookId(args.bookId);
        if (!bookId) return failure('INVALID_BOOK_ID', 'معرّف الكتاب مطلوب وصيغته غير صالحة.');
        const raw = await readOutlineSource(bookId);
        if (raw == null) return failure('OUTLINE_NOT_FOUND', `لا يوجد ملف فهرس مساعد للكتاب ${bookId}.`);
        const lines = raw.split(/\r?\n/);
        const offset = asOffset(args.offset);
        const limit = asLimit(args.limit, 120);
        const selected = lines.slice(offset, offset + limit);
        const nextOffset = offset + selected.length < lines.length ? offset + selected.length : null;
        return success(JSON.stringify({
          bookId,
          kind: 'raw-outline-not-page-text',
          notice: 'هذا ملف فهرس مساعد كما خُزّن؛ ليس نص صفحة PDF ولا دليلاً حرفياً. لم تُحذف أو تُعدّل أسطره في هذه الأداة.',
          totalLines: lines.length,
          offset,
          nextOffset,
          lines: selected,
        }), { bookId, totalLines: lines.length, offset, nextOffset });
      }
      case 'get_page_neighbors': {
        const bookId = validBookId(args.bookId);
        if (!bookId) return failure('INVALID_BOOK_ID', 'معرّف الكتاب مطلوب وصيغته غير صالحة.');
        const physicalPage = asPage(args.physicalPage);
        const printedPage = asPage(args.printedPage);
        if (physicalPage == null && printedPage == null) return failure('PAGE_REQUIRED', 'مرّري رقم صفحة مطبوع أو رقم صفحة PDF.');
        let currentPhysical = physicalPage;
        if (currentPhysical == null) {
          const located = await physicalPageFor(bookId, printedPage);
          if (located.ambiguous) return failure('AMBIGUOUS_PRINTED_PAGE', `الصفحة المطبوعة ${printedPage} تقابل أكثر من صفحة PDF. حددي physicalPage من هذه الخيارات: ${JSON.stringify(located.matches)}`, { candidates: located.matches });
          currentPhysical = located.physicalPage;
        }
        if (currentPhysical == null) return failure('PAGE_NOT_FOUND', `لا توجد خريطة للصفحة المطبوعة ${printedPage} في ${bookId}.`);
        const book = (await listBooks()).find((entry) => entry.id === bookId);
        const pages = [];
        for (const number of [currentPhysical - 1, currentPhysical, currentPhysical + 1]) {
          if (number < 1 || number > Number(book?.pageCount || 0)) continue;
          try {
            const page = await fullPage(bookId, number);
            pages.push(page);
          } catch (error) {
            pages.push({ bookId, physicalPage: number, error: String(error?.message || error) });
          }
        }
        const citations = pages.filter((page) => !page.error).map((page) => citationOf(book, page));
        return success(pages.map((page) => page.error
          ? `=== PDF ${page.physicalPage}: فشل فتح بيانات الصفحة: ${page.error} ===`
          : pageContent(book, page)).join('\n\n'), {
          bookId, currentPhysical, citations, pages: pages.length,
        });
      }
      default:
        return failure('UNKNOWN_TOOL', `اسم الأداة غير معروف: ${String(name || '(فارغ)')}`);
    }
  } catch (error) {
    const detail = String(error?.message || error || 'Unknown tool error');
    return failure(error?.code || 'TOOL_EXECUTION_FAILED', `تعذر تنفيذ ${String(name || 'الأداة')}: ${detail}`, { detail });
  }
}
