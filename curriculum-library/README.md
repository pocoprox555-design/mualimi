# مكتبة منهج «معلمي»

هذه المكتبة هي المرجع المحلي القابل للبحث للنموذج. ملفات PDF وملفات النص المرقمة هي مصدر الحقيقة، أما `pdf-index.json` و`pdf-books` و`index` فهي مخرجات مشتقة قابلة لإعادة البناء.

## استيراد ملف نصي مرقّم

```bash
npm run curriculum:import -- "D:/path/book.txt" \
  --id islamic-sixth-preparatory-2025 \
  --title "القرآن الكريم والتربية الإسلامية للصف السادس الإعدادي" \
  --subject "التربية الإسلامية" \
  --branch "عام" \
  --edition "الطبعة التاسعة" \
  --year 2025
```

المستورد يدعم الفواصل `----- [ صفحة 1 ] -----` والأسطر `[ص1-س1]`. الصفحات التي لا تحتوي نصًا لا تُحذف، بل تُعلّم `needsOcr`.

## الأوامر

- `npm run curriculum:pdf-index` — استخراج فهرس PDF schema v2 من `pdf-sources` مع المطابقة المطبوعة/الفيزيائية.
- `npm run curriculum:reindex` — إعادة بناء الفهارس المشتقة للكتب المرقمة وPDF.
- `npm run curriculum:rebuild` — إعادة بناء كاملة متسلسلة: PDF ثم الخرائط والملخصات والبحث.
- `npm run curriculum:validate` — فحص manifests والصفحات والبصمات ومخرجات schema v2.

## شكل الفهرس المشتق

`pdf-index.json` وملف كل كتاب في `pdf-books` يستخدمان `schemaVersion: 2`. لكل كتاب توجد هوية المادة ومصدر PDF وبصمته وحالته المرجعية، ولكل صفحة `physicalPage` و`printedPage` و`fullText` و`searchable` و`ocr` و`title` و`summary` و`section` و`unit` و`pageType` و`educationalPurpose` و`neighbors` و`sourceProvenance`. رقم الصفحة المطبوع قد يكون `null` عندما لا يثبت من النص أو من الاستمرارية؛ لا يُخمنه الفهرس.

### `search-index.json` هو مصدر الحقيقة وقت التشغيل (`schemaVersion: 4`)

الفهرس **مكتفي بذاته**: كل صفحة لها `text` كامل بلا اقتطاع، ولا يُقرأ أي ملف صفحة ولا PDF ولا `pdf-books` أثناء التشغيل. `lib/index.mjs` يقرأ `search-index.json` وحده.

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

### تنقية

`usableText()` في `scripts/build-index.mjs` يحذف حروف المصنع (`IRAQ_G12_SB_2024.indb`) والتواريخ، ويحذف رقم الصفحة المطبوع الملتصق بأول النص وآخره قبل الفهرسة. آخر فهرس نُظّف بذلك: 19,536 حرف حروف مصنع أُزيلت، و0 كلمة مفتاحية رقمية.

- `npm test` — اختبارات parser والتطبيع والبحث والأمان.


## حقوق المحتوى

لا تضف كتابًا من مرآة غير رسمية إلا إذا كان لديك حق قانوني لاستخدامه. `sources.json` كتالوج متابعة ولا يمنح إذنًا بالتنزيل أو إعادة التوزيع.
