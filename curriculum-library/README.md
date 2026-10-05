# مكتبة منهج «معلمي»

هذه المكتبة هي المرجع المحلي القابل للبحث للنموذج. ملفات PDF في `pdf-sources` هي مصادر PDF الأصلية؛ أما `pdf-index.json` و`pdf-books` و`outlines` و`search-index.json` فهي بيانات مشتقة.

## الأوامر الفعلية في `package.json`

- `npm ci` — تثبيت الاعتماديات وفق `package-lock.json`.
- `npm run import-deni` — استيراد كتب التعليم الديني من ملفات `pdf-sources`.
- `npm run rebuild-pdf-index` — إعادة بناء `pdf-index.json` من ملفات `pdf-books` الموجودة؛ لا يستخرج PDF من جديد.
- `npm run build-index` — بناء `search-index.json` من `pdf-index.json` وملفات `outlines` و`enrichment`.
- `npm run validate-index` — طباعة تقرير التحقق الكامل.
- `npm run gate` — تشغيل بوابة الفهرس وإرجاع فشل عند وجود فجوات حرجة.
- `npm test` — تشغيل مجموعة الاختبارات المحددة في `package.json`.
- `npm run verify` — تشغيل `rebuild-pdf-index` ثم `build-index` ثم `gate` ثم `npm test`.

## شكل الفهرس المشتق

يستخدم `pdf-index.json` الحالي `schemaVersion: 2`. ملفات `pdf-books` تحمل مخططات المصدر الخاصة بها؛ في البيانات الحالية توجد سجلات بإصداري 1 و2. تتضمن سجلات الكتب هوية المادة ومصدر PDF وبصمته، وتتضمن الصفحات حقولًا مثل `physicalPage` و`printedPage` و`fullText` و`searchable` و`ocr` و`title` و`summary` و`section` و`unit` و`pageType` و`educationalPurpose` و`neighbors` و`sourceProvenance`. رقم الصفحة المطبوع قد يكون `null` عندما لا يثبت من النص أو من الاستمرارية؛ لا يُخمنه الفهرس.

### `search-index.json` (`schemaVersion: 4`)

يحتوي الفهرس نص الصفحات المفهرس كاملًا بلا اقتطاع، ويستخدمه `lib/index.mjs` للبحث واسترجاع النص. بيانات التشغيل الأخرى لها قراءاتها الخاصة: `lib/outline.mjs` يقرأ `outlines` و`pdf-books` لإسناد أوصاف المخططات، وملفات `pdf-sources` الأصلية متاحة لمسار قراءة PDF الاحتياطي عند غياب نص مفهرس كافٍ.

لكل وثيقة: `text` و`textLength` و`normalized` (غير مقصوص) و`preview` (أول 700 وآخر 400 حرف مع علامة صريحة بالمحذوف) و`pageOffset` (= `printedPage − physicalPage`) و`terms` و`keywords` (بلا أرقام) و`enriched`.

**حقول اختيارية تأتي من التغذية** في `curriculum-library/enrichment/<bookId>.json`، وتُنتجها مراجعة بصرية لصور الصفحات:

| الحقل | الغرض |
|---|---|
| `unit` / `work` / `author` / `sectionPath` | هوية الدرس كاملة؛ الوحدة تُسمّي العمل (`Literature Focus — As You Like It`) فلا تتناقض مع `work` |
| `actScene` | رقم المشهد `[4, 3]` لمطابقة سؤال «الفصل 4 المشهد 3» |
| `title` / `titleEn` / `summary` / `summaryEn` | وصف يغطي **كامل** الصفحة لا أول جملتين |
| `glossary` / `glossaryRefs` / `vocabulary` | كل مفردة معرّفة في الصفحة، ومكان تعريف كل كلمة معلّمة بنجمة |
| `figures[]` | وصف كل رسمة: من فيها، ماذا يفعل، وأين — وهو الجواب الوحيد عن سؤال «انظر إلى الصورة» |
| `activities[]` / `exercises[]` | التمارين بحروفها وأرقامها، والفراغات بشرطاتها، وصيغة الإجابة (`checkboxes_6`، `ruled_lines_8`…)، وحقل `dispatch` لأحالة كتاب التمارين |
| `answerKeyLocation` / `continuesOn` / `recapOf` / `notes` | أين الإجابات، وأين يكمل النشاط، وما الذي يلخّصه صندوق القصة |

مخطط الحقول وقواعدها الإلزامية (لا تختلق، احفظ الشرطات، الأرقام فاطحة) في `.pdfverify/enrichment-schema.md`.

### التحقق والبناء في Docker

مرحلة التحقق في `Dockerfile` تحتاج `pdf-sources` للتحقق من البصمات و`pdf-books` لإعادة بناء الفهارس وتشغيل البوابة والاختبارات. الصورة النهائية تنسخ ملفات التشغيل فقط: `search-index.json` و`pdf-index.json` و`pdf-books` و`outlines` و`pdf-sources`، ولا تتضمن سكربتات البناء أو الاختبارات.

### تنقية

`usableText()` في `scripts/build-index.mjs` يحذف حروف المصنع (`IRAQ_G12_SB_2024.indb`) والتواريخ، ويحذف رقم الصفحة المطبوع الملتصق بأول النص وآخره قبل الفهرسة.

## حقوق المحتوى

لا تضف كتابًا من مرآة غير رسمية إلا إذا كان لديك حق قانوني لاستخدامه. `sources.json` كتالوج متابعة ولا يمنح إذنًا بالتنزيل أو إعادة التوزيع.
