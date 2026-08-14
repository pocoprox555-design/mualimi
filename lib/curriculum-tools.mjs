import {
  inspectBook,
  listBookSections,
  listMaterials,
  openAdjacentPages,
  openPage,
  openPages,
  readBookGuide,
  searchLibrary,
} from './curriculum-library.mjs'
import { searchCurriculum } from '../curriculum.mjs'
import { inspectPdfBook, listPdfBooks, locatePdfPage, locatePdfPages, openPdfPages, searchPdfLibrary } from './pdf-curriculum.mjs'

const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const stringField = (description) => ({ type: 'string', description })
const pageField = { type: 'integer', minimum: 1, description: 'رقم الصفحة المطبوع في الكتاب' }
const pdfPageField = { type: 'integer', minimum: 1, description: 'رقم الصفحة داخل ملف PDF (1 إلى pageCount)' }
const quizQuestion = {
  type: 'object',
  properties: {
    prompt: stringField('نص السؤال'),
    type: { type: 'string', enum: ['multiple_choice', 'true_false'] },
    options: { type: 'array', minItems: 2, maxItems: 6, items: stringField('خيار الإجابة') },
    correctIndex: { type: 'integer', minimum: 0, maximum: 5 },
    explanation: stringField('شرح قصير للإجابة الصحيحة'),
  },
  required: ['prompt', 'type', 'options', 'correctIndex', 'explanation'],
  additionalProperties: false,
}

export const curriculumToolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'set_conversation_title',
      description: 'سمّ المحادثة بعنوان قصير وواضح من فهمك لنية الطالبة وموضوعها. استخدمها بعد أول رسالة أو عند تغير موضوع المحادثة، ولا تنسخ سؤال الطالبة حرفياً.',
      parameters: objectSchema({ title: stringField('عنوان من كلمتين إلى ست كلمات') }, ['title']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'present_quiz',
      description: 'اعرض اختباراً تفاعلياً للطالبة عندما تفهم أن نيتها حل اختبار. لا تستخدم Markdown للأسئلة. أرسل الأسئلة والخيارات والإجابة الصحيحة وشرحها في هذه الأداة، ولا تصحح قبل اختيار الطالبة.',
      parameters: objectSchema({
        title: stringField('عنوان الاختبار'),
        subject: stringField('المادة كما فهمتها من نية الطالبة'),
        questions: { type: 'array', minItems: 1, maxItems: 50, items: quizQuestion },
      }, ['title', 'subject', 'questions']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_subject_choice',
      description: 'اعرض بطاقات المواد فقط عندما تكون نية الطالبة واضحة لكن المادة غير محسومة. لا تخمّن المادة ولا تكتب قائمة Markdown.',
      parameters: objectSchema({
        question: stringField('سؤال قصير للطالبة يوضح سبب طلب الاختيار'),
        choices: { type: 'array', minItems: 2, maxItems: 12, items: {
          type: 'object',
          properties: { id: stringField('معرف المادة'), title: stringField('اسم المادة'), icon: stringField('رمز أو أيقونة مناسبة') },
          required: ['id', 'title', 'icon'],
          additionalProperties: false,
        } },
      }, ['question', 'choices']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_materials',
      description: 'اعرض مجلد المواد والكتب المتاحة وإصداراتها قبل اختيار المرجع المناسب.',
      parameters: objectSchema({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_book',
      description: 'افحص بيانات كتاب وعدد صفحاته وحالة النص قبل قراءته.',
      parameters: objectSchema({ bookId: stringField('المعرف كما ظهر في list_materials') }, ['bookId']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_book_guide',
      description: 'اقرأ المرجع السريع للكتاب: عنوان وملخص ونوع كل صفحة. استخدم cursor للتنقل بين دفعات الخريطة.',
      parameters: objectSchema({
        bookId: stringField('معرف الكتاب'),
        cursor: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 40, default: 24 },
      }, ['bookId']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_book_sections',
      description: 'اعرض أقسام الكتاب ونطاقات صفحاتها لتخطيط القراءة.',
      parameters: objectSchema({ bookId: stringField('معرف الكتاب') }, ['bookId']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_page',
      description: 'افتح صفحة واحدة كاملة من كتاب مع بيانات الاستشهاد.',
      parameters: objectSchema({ bookId: stringField('معرف الكتاب'), pageNumber: pageField }, ['bookId', 'pageNumber']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_pages',
      description: 'افتح صفحات محددة اختارها النموذج من كتاب واحد.',
      parameters: objectSchema({
        bookId: stringField('معرف الكتاب'),
        pageNumbers: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: pageField },
      }, ['bookId', 'pageNumbers']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_adjacent',
      description: 'اقرأ الصفحة المطلوبة وما حولها عندما يمتد الدرس عبر صفحات متتابعة.',
      parameters: objectSchema({
        bookId: stringField('معرف الكتاب'),
        pageNumber: pageField,
        radius: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
      }, ['bookId', 'pageNumber']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_book',
      description: 'بحث اختياري داخل كتاب أو كل الكتب. استعمله فقط إذا قررت أنه أسرع من تصفح الخريطة.',
      parameters: objectSchema({
        query: stringField('المعنى أو العبارة المطلوب العثور عليها'),
        bookId: stringField('معرف كتاب اختياري'),
        subject: stringField('مادة اختيارية'),
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 },
      }, ['query']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_uploaded_materials',
      description: 'ابحث في الملفات المساعدة التي رفعها المستخدم. هذه الملفات ليست بديلاً عن كتب المنهج المرقمة ولا تمنح استشهاداً بصفحة إلا إذا احتوت على ترقيم واضح.',
      parameters: objectSchema({
        query: stringField('المعنى أو العبارة المطلوب العثور عليها'),
        limit: { type: 'integer', minimum: 1, maximum: 8, default: 6 },
      }, ['query']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_pdf_books',
      description: 'اعرض كتب PDF المدرسية المتاحة مع عدد الصفحات وحالة الفهرسة.',
      parameters: objectSchema({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'inspect_pdf_book',
      description: 'افحص كتاب PDF وعدد صفحاته قبل اختيار صفحات منه.',
      parameters: objectSchema({ bookId: stringField('معرف كتاب PDF') }, ['bookId']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_pdf_books',
      description: 'ابحث بسرعة في فهرس كتب PDF للوصول إلى الصفحات المناسبة للسؤال.',
      parameters: objectSchema({ query: stringField('السؤال أو العبارة المطلوب العثور عليها'), subject: stringField('مادة اختيارية'), limit: { type: 'integer', minimum: 1, maximum: 20, default: 8 } }, ['query']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'locate_pdf_page',
      description: 'حوّل رقم الصفحة المطبوع الذي ذكرته الطالبة إلى رقم صفحة PDF الفعلي قبل فتحها.',
      parameters: objectSchema({ bookId: stringField('معرف كتاب PDF'), printedPageNumber: pageField }, ['bookId', 'printedPageNumber']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'locate_pdf_pages',
      description: 'حوّل عدة أرقام صفحات مطبوعة إلى أرقام PDF الفعلية دفعة واحدة. استعمل هذه الأداة بدلاً من locate_pdf_page عندما تذكر الطالبة نطاقاً (مثل من 1 إلى 20) أو عدة صفحات. تعيد خريطة {printedPageNumber → pdfPageNumber} لكل رقم، وقائمة notFound للأرقام التي لم توجد.',
      parameters: objectSchema({
        bookId: stringField('معرف كتاب PDF'),
        printedPageNumbers: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: pageField },
      }, ['bookId', 'printedPageNumbers']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_pdf_pages_as_images',
      description: 'افتح صفحات PDF كصور عالية الوضوح للنموذج الداعم للرؤية. استخدمها عندما يكون النص ناقصاً أو تحتاج دقة الصفحة الأصلية.',
      parameters: objectSchema({ bookId: stringField('معرف كتاب PDF'), pageNumbers: { type: 'array', minItems: 1, maxItems: 25, uniqueItems: true, items: pdfPageField } }, ['bookId', 'pageNumbers']),
    },
  },
]

function citationFromPage(page) {
  return {
    bookId: page.book.id,
    title: page.book.title,
    subject: page.book.subject,
    edition: page.book.edition,
    year: page.book.year,
    pageNumber: page.pageNumber,
    lineRange: page.lineRange,
  }
}

export function createCurriculumTools() {
  const openedCitations = new Map()
  const rememberPages = (pages) => {
    for (const page of pages) openedCitations.set(`${page.book.id}:${page.pageNumber}`, citationFromPage(page))
    return pages
  }

  return {
    definitions: curriculumToolDefinitions,
    openedCitations,
    handlers: {
      set_conversation_title: async ({ title }) => ({ title: String(title || 'محادثة دراسية').trim().slice(0, 100) }),
      present_quiz: async ({ title, subject, questions }) => {
        const cleaned = (Array.isArray(questions) ? questions : [])
          .filter((question) => question && String(question.prompt || '').trim() && (Array.isArray(question.options) ? question.options.length : 0) >= 2)
          .slice(0, 50)
        // اختبار بلا أسئلة صالحة = استدعاء مبتور (غالبًا بسبب حد الرموز)؛ لا نعرض
        // بطاقة فارغة للطالبة بل نعيد خطأً يوجّه النموذج لإعادة المحاولة نصيًا.
        if (!cleaned.length) {
          return { error: 'EMPTY_QUIZ', instruction: 'لم تصل أسئلة صالحة للاختبار. أعد الإجابة برسالة نصية عادية أو أعد استدعاء الأداة بأسئلة كاملة.' }
        }
        return {
          ui: 'quiz',
          title: String(title || 'اختبار').slice(0, 160),
          subject: String(subject || '').slice(0, 100),
          questions: cleaned.map((question) => ({
            prompt: String(question.prompt || '').slice(0, 1000),
            type: question.type === 'true_false' ? 'true_false' : 'multiple_choice',
            options: (Array.isArray(question.options) ? question.options : []).slice(0, 6).map((option) => String(option).slice(0, 300)),
            correctIndex: Math.max(0, Math.min(Number(question.correctIndex) || 0, (question.options?.length || 1) - 1)),
            explanation: String(question.explanation || '').slice(0, 800),
          })),
        }
      },
      ask_subject_choice: async ({ question, choices }) => ({
        ui: 'subject-choice',
        question: String(question || 'اختاري المادة التي تريدين الدراسة فيها.').slice(0, 300),
        choices: (Array.isArray(choices) ? choices : []).slice(0, 12).map((choice) => ({
          id: String(choice.id || choice.title || '').slice(0, 80),
          title: String(choice.title || '').slice(0, 120),
          icon: String(choice.icon || '📚').slice(0, 8),
        })),
      }),
      list_materials: async () => ({ folder: 'المواد', materials: await listMaterials(), pdfBooks: await listPdfBooks() }),
      inspect_book: async ({ bookId }) => inspectBook(bookId),
      read_book_guide: async ({ bookId, cursor = 0, limit = 24 }) => readBookGuide(bookId, { cursor, limit }),
      list_book_sections: async ({ bookId }) => listBookSections(bookId),
      open_page: async ({ bookId, pageNumber }) => rememberPages([await openPage(bookId, pageNumber)])[0],
      open_pages: async ({ bookId, pageNumbers }) => rememberPages(await openPages(bookId, pageNumbers)),
      read_adjacent: async ({ bookId, pageNumber, radius = 1 }) => rememberPages(await openAdjacentPages(bookId, pageNumber, radius)),
      search_book: async ({ query, bookId = null, subject = null, limit = 8 }) => {
        const results = await searchLibrary(query, { bookId, subject, limit })
        return { results: results.map((result) => ({ score: result.score, citation: result.citation, preview: result.preview })) }
      },
      search_uploaded_materials: async ({ query, limit = 6 }) => {
        const result = await searchCurriculum(query, limit)
        return { results: result.results.map(({ content, terms, ...item }) => item), context: result.context }
      },
      list_pdf_books: async () => ({ books: await listPdfBooks() }),
      inspect_pdf_book: async ({ bookId }) => inspectPdfBook(bookId),
      search_pdf_books: async ({ query, subject = null, limit = 8 }) => ({ results: await searchPdfLibrary(query, { subject, limit }) }),
      locate_pdf_page: async ({ bookId, printedPageNumber }) => locatePdfPage(bookId, printedPageNumber),
      locate_pdf_pages: async ({ bookId, printedPageNumbers }) => locatePdfPages(bookId, printedPageNumbers),
      open_pdf_pages_as_images: async ({ bookId, pageNumbers }) => {
        const pages = await openPdfPages(bookId, pageNumbers)
        for (const page of pages) openedCitations.set(`${bookId}:${page.pageNumber}`, {
          bookId,
          title: page.title,
          subject: page.subject,
          pageNumber: page.pageNumber,
          printedPageNumber: page.printedPageNumber || null,
        })
        return { visionPages: pages }
      },
    },
  }
}
