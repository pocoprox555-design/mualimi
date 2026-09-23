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
const pageField = { type: 'integer', minimum: 1, description: 'رقم الصفحة المطبوع أو الفيزيائي حسب الأداة' }
const pdfPageField = { type: 'integer', minimum: 1, description: 'رقم الصفحة الفيزيائي داخل ملف PDF' }
const quizQuestion = {
  type: 'object',
  properties: {
    prompt: stringField('نص السؤال المبني على الصفحات المقروءة'),
    type: { type: 'string', enum: ['multiple_choice', 'true_false'] },
    options: { type: 'array', minItems: 2, maxItems: 6, items: stringField('خيار الإجابة') },
    correctIndex: { type: 'integer', minimum: 0, maximum: 5 },
    explanation: stringField('سبب الإجابة الصحيحة')
  },
  required: ['prompt', 'type', 'options', 'correctIndex', 'explanation'],
  additionalProperties: false,
}

export const curriculumToolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'set_conversation_title',
      description: 'ضع عنواناً وصفياً قصيراً للمحادثة بعد فهم موضوعها، دون نسخ سؤال رحما حرفياً.',
      parameters: objectSchema({ title: stringField('عنوان من كلمتين إلى ست كلمات') }, ['title']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'present_quiz',
      description: 'اعرض اختباراً تفاعلياً بعد قراءة المرجع الفعلي. لا تستخدمها قبل اكتمال الأسئلة ولا تكرر الأسئلة في جواب Markdown.',
      parameters: objectSchema({
        title: stringField('عنوان الاختبار'),
        subject: stringField('المادة'),
        questions: { type: 'array', minItems: 1, maxItems: 50, items: quizQuestion },
      }, ['title', 'subject', 'questions']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_subject_choice',
      description: 'اعرض اختيار مادة عندما تكون نية رحما واضحة لكن المادة لا يمكن تحديدها من السياق.',
      parameters: objectSchema({
        question: stringField('سؤال اختيار قصير'),
        choices: { type: 'array', minItems: 2, maxItems: 12, items: objectSchema({ id: stringField('معرف المادة'), title: stringField('اسم المادة'), icon: stringField('رمز بصري') }, ['id', 'title', 'icon']) },
      }, ['question', 'choices']),
    },
  },
  { type: 'function', function: { name: 'list_materials', description: 'اعرض الكتب والمراجع المتاحة لتحديد المرجع الصحيح.', parameters: objectSchema({}) } },
  { type: 'function', function: { name: 'inspect_book', description: 'افحص بيانات كتاب وعدد صفحاته وحالة OCR قبل القراءة.', parameters: objectSchema({ bookId: stringField('معرف الكتاب') }, ['bookId']) } },
  { type: 'function', function: { name: 'read_book_guide', description: 'اقرأ خريطة صفحات الكتاب وعناوينها وملخصاتها على دفعات.', parameters: objectSchema({ bookId: stringField('معرف الكتاب'), cursor: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 40 } }, ['bookId']) } },
  { type: 'function', function: { name: 'list_book_sections', description: 'اعرض أقسام الكتاب ونطاقات الصفحات لتخطيط القراءة.', parameters: objectSchema({ bookId: stringField('معرف الكتاب') }, ['bookId']) } },
  { type: 'function', function: { name: 'open_page', description: 'افتح صفحة كاملة واحدة واقرأ نصها الفعلي قبل الاستشهاد بها.', parameters: objectSchema({ bookId: stringField('معرف الكتاب'), pageNumber: pageField }, ['bookId', 'pageNumber']) } },
  { type: 'function', function: { name: 'open_pages', description: 'افتح مجموعة صفحات محددة من الكتاب نفسه.', parameters: objectSchema({ bookId: stringField('معرف الكتاب'), pageNumbers: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: pageField } }, ['bookId', 'pageNumbers']) } },
  { type: 'function', function: { name: 'read_adjacent', description: 'افتح الصفحة وما حولها عندما يمتد الدرس أو يحتاج سياقاً قريباً.', parameters: objectSchema({ bookId: stringField('معرف الكتاب'), pageNumber: pageField, radius: { type: 'integer', minimum: 1, maximum: 5 } }, ['bookId', 'pageNumber']) } },
  { type: 'function', function: { name: 'search_book', description: 'ابحث نصياً للوصول إلى الصفحات المرشحة، ثم افتح النتائج قبل الإجابة.', parameters: objectSchema({ query: stringField('المعنى أو العبارة'), bookId: stringField('معرف اختياري'), subject: stringField('مادة اختيارية'), limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']) } },
  { type: 'function', function: { name: 'search_uploaded_materials', description: 'ابحث في ملف مساعد مرفوع، مع إبقائه مميزاً عن المرجع الرسمي.', parameters: objectSchema({ query: stringField('المعنى أو العبارة'), limit: { type: 'integer', minimum: 1, maximum: 12 } }, ['query']) } },
  { type: 'function', function: { name: 'list_pdf_books', description: 'اعرض ملفات PDF المدرسية المفهرسة ومعلومات مصدرها.', parameters: objectSchema({}) } },
  { type: 'function', function: { name: 'inspect_pdf_book', description: 'افحص كتاب PDF وعدد صفحاته وحالة النص والمطابقة.', parameters: objectSchema({ bookId: stringField('معرف PDF') }, ['bookId']) } },
  { type: 'function', function: { name: 'search_pdf_books', description: 'ابحث في النص المفهرس لكتب PDF للوصول إلى صفحات مرشحة.', parameters: objectSchema({ query: stringField('السؤال أو العبارة'), subject: stringField('مادة اختيارية'), limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']) } },
  { type: 'function', function: { name: 'locate_pdf_page', description: 'حوّل صفحة مطبوعة واحدة إلى صفحة فيزيائية داخل PDF.', parameters: objectSchema({ bookId: stringField('معرف PDF'), printedPageNumber: pageField }, ['bookId', 'printedPageNumber']) } },
  { type: 'function', function: { name: 'locate_pdf_pages', description: 'حوّل عدة أرقام مطبوعة دفعة واحدة إلى صفحات فيزيائية.', parameters: objectSchema({ bookId: stringField('معرف PDF'), printedPageNumbers: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: pageField } }, ['bookId', 'printedPageNumbers']) } },
  { type: 'function', function: { name: 'open_pdf_pages_as_images', description: 'افتح الصفحات الفيزيائية المحددة كنص كامل وصور عند نقص OCR أو الحاجة إلى الدقة البصرية.', parameters: objectSchema({ bookId: stringField('معرف PDF'), pageNumbers: { type: 'array', minItems: 1, maxItems: 25, uniqueItems: true, items: pdfPageField } }, ['bookId', 'pageNumbers']) } },
]

function citationFromPage(page) {
  return {
    bookId: page.book?.id,
    title: page.book?.title,
    subject: page.book?.subject,
    edition: page.book?.edition,
    year: page.book?.year,
    pageNumber: page.physicalPage ?? page.pageNumber,
    printedPageNumber: page.printedPage ?? page.printedPageNumber ?? null,
    lineRange: page.lineRange || null,
    sourceProvenance: page.sourceProvenance || null,
  }
}

export function createCurriculumTools() {
  const openedCitations = new Map()
  const publicPdfBook = ({ file, ...book }) => book
  const rememberPages = (pages) => {
    for (const page of pages || []) {
      const citation = citationFromPage(page)
      if (citation.bookId && citation.pageNumber != null) openedCitations.set(`${citation.bookId}:${citation.pageNumber}`, citation)
    }
    return pages
  }

  return {
    definitions: curriculumToolDefinitions,
    openedCitations,
    handlers: {
      set_conversation_title: async ({ title }) => ({ title: String(title || 'محادثة دراسية').trim().slice(0, 100) || 'محادثة دراسية' }),
      present_quiz: async ({ title, subject, questions }) => {
        const cleaned = (Array.isArray(questions) ? questions : []).filter((question) => {
          const options = Array.isArray(question?.options) ? question.options : []
          return String(question?.prompt || '').trim() && options.length >= 2 && Number.isInteger(Number(question?.correctIndex)) && Number(question.correctIndex) >= 0 && Number(question.correctIndex) < options.length
        }).slice(0, 50)
        if (!cleaned.length) return { error: 'EMPTY_QUIZ', instruction: 'أعد بناء الأسئلة من الصفحات المقروءة أو اشرح الفكرة نصياً.' }
        return {
          ui: 'quiz',
          title: String(title || 'اختبار').trim().slice(0, 160),
          subject: String(subject || '').trim().slice(0, 100),
          questions: cleaned.map((question) => ({
            prompt: String(question.prompt).slice(0, 1_000),
            type: question.type === 'true_false' ? 'true_false' : 'multiple_choice',
            options: question.options.slice(0, 6).map((option) => String(option).slice(0, 300)),
            correctIndex: Number(question.correctIndex),
            explanation: String(question.explanation || '').slice(0, 800),
          })),
        }
      },
      ask_subject_choice: async ({ question, choices }) => ({
        ui: 'subject-choice',
        question: String(question || 'اختاري المادة التي تريدين دراستها.').slice(0, 300),
        choices: (Array.isArray(choices) ? choices : []).slice(0, 12).map((choice) => ({ id: String(choice.id || choice.title || '').slice(0, 80), title: String(choice.title || '').slice(0, 120), icon: String(choice.icon || '📚').slice(0, 8) })),
      }),
      list_materials: async () => ({ materials: await listMaterials(), pdfBooks: (await listPdfBooks()).map(publicPdfBook) }),
      inspect_book: async ({ bookId }) => inspectBook(bookId),
      read_book_guide: async ({ bookId, cursor = 0, limit = 24 }) => readBookGuide(bookId, { cursor, limit }),
      list_book_sections: async ({ bookId }) => listBookSections(bookId),
      open_page: async ({ bookId, pageNumber }) => rememberPages([await openPage(bookId, pageNumber)])[0],
      open_pages: async ({ bookId, pageNumbers }) => rememberPages(await openPages(bookId, pageNumbers)),
      read_adjacent: async ({ bookId, pageNumber, radius = 1 }) => rememberPages(await openAdjacentPages(bookId, pageNumber, radius)),
      search_book: async ({ query, bookId = null, subject = null, limit = 8 }) => ({ results: (await searchLibrary(query, { bookId, subject, limit })).map(({ content, ...result }) => result) }),
      search_uploaded_materials: async ({ query, limit = 6 }) => {
        const result = await searchCurriculum(query, limit)
        return { results: result.results.map(({ content, terms, ...item }) => item), context: result.context, sourceProvenance: 'uploaded-material' }
      },
      list_pdf_books: async () => ({ books: (await listPdfBooks()).map(publicPdfBook) }),
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
          sourceProvenance: page.sourceProvenance || null,
        })
        return { visionPages: pages }
      },
    },
  }
}
