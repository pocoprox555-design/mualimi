# تدقيق عميق — دليل المدرس لمادة الأدب الإنكليزي (سادس إعدادي)

> كل رقم في هذا التقرير مقيس من الملفات الحقيقية في `D:\NT\APP CHAT`.
> مصدر الحقيقة: `curriculum-library/pdf-sources/دليل المدرس لمادة الادب انكليزي سادس اعدادي.pdf` (739,838 بايت، sha256 `79f217b228090802b8c847382e07a158f2ffa45a21c43a9908b1ea83c33f4c2b`).
> نطاق التدقيق: كل الصفحات الـ28 (فحص كامل، لا عيّنة).
> لم يُعدَّل أي ملف في المشروع.

---

## 1. بطاقة الكتاب

| الحقل | القيمة المقيسة | الملاحظة |
|---|---|---|
| bookId | `english-literature-teacher-guide-95722f85-pdf` | — |
| العنوان | دليل مدرس الأدب الإنكليزي — دليل المدرس لمادة الادب انكليزي سادس اعدادي | — |
| `subject` | دليل المدرس | صحيح لنوع الوثيقة |
| `grade` / `branch` / `year` | السادس الإعدادي / أدبي / 2025 | — |
| `referenceKind` | `teacher-guide` | ✅ **نوع الدليل مُعلَّم صحيحاً** |
| `sourceProvenance.authority` | `supporting-reference` | ✅ التمييز الوحيد في 21 كتاباً — علامة صحيحة |
| عدد صفحات PDF | **28** | مطابق تماماً |
| `pdf-books/*.json` | 28 صفحة، schemaVersion 2 | ✅ |
| `pdf-index.json` | مدخل واحد، 28 صفحة، schemaVersion 2 | ✅ |
| `search-index.json` | 28 وثيقة، schemaVersion 4، `builtAt` = 2026-09-28T22:27:41.426Z | ✅ |
| `fast-index.json` | مدخل واحد، 28 صف، version 1 | ⚠️ طبقة قديمة (12 كتاباً / 1456 صفحة) |
| `outlines/*.md` | ملف واحد، **50,843 حرفاً / 411 سطراً** | ✅ الأدق والأغنى على الإطلاق |
| `enrichment/*.json` | **غير موجود** | ❌ الفجوة الأكبر |
| `searchable` | 28/28 | ✅ |
| `needsOcr` | 28/28 = false، `ocr.status` = `text` | ✅ لا يحتاج OCR |
| المسافة المطبوعة | 178 → 205، ثابتة `pageOffset = 177` | ✅ |

### تفسير الـ hash داخل الـ id

تم التحقق آلياً: `95722f85` = **أول 8 محارف من SHA-256 لاسم ملف PDF كاملاً مع الامتداد**:

```
sha256("دليل المدرس لمادة الادب انكليزي سادس اعدادي.pdf")
  = 95722f855813801a697c1c7b3525efff9038553e394cd317c4f60de479c665bb
  → أول 8 = 95722f85  ✅
```

- تجزئة **اسم** وليست تجزئة **محتوى**. التجزئة الحقيقية للمحتوى موجودة ومنفصلة في `source.checksum` = `79f217b2…`.
- **النتيجة العملية:** الـ id **مستقر** طالما بقي اسم الملف كما هو (تغيير المحتوى لا يغيّر الـ id). لكنه **ليس content-addressed**: استبدال محتوى الـ PDF باسم واحد يبقي الـ id كما هو مع فهرس قديم كاذب، وإعادة التسمية تولّد id جديداً يتيم.
- الدالة المولِّدة للـ hash **غير موجودة في `scripts/`** — `createHash` الوحيد في `scripts/import-deni-books.mjs:195` ويحسب checksum للمحتوى فقط. أي أن توليد الـ id يدوي/خارجي وم patriarchy غير موثّقة في المستودع.

###Map الدرس الفعلي (مقيس من النص، ومطابق لخريطة الـ outline)

| الكتلة | فيزيائية | مطبوعة |
|---|---|---|
| Guidance notes for Literature Focus | 1–2 | 178–179 |
| Pride and Prejudice — Introduction | 3 | 180 |
| PPP Sections 1..6 | 4–5, 6–7, 8–9, 10–11, 12–13, 14–15 | 181–192 |
| As You Like It — Introduction | 16 | 193 |
| AYLI Sections 1..6 | 17–18, 19–20, 21–22, 23–23, 25–26, 27–28 | 194–205 |

**ملاحظة تصحيح:** خريطة الـ outline كُتبت فيها `AYLI Section 4 | 23–23` بينما الصحيح `23–24`. خطأ مطبعي في الـ outline فقط، والـ pdf-books unaffected (physicalPage 23→pp200، 24→pp201 صحيحان).

---

## 2. جدول الأرقام

| المقياس | القيمة | الحكم |
|---|---|---|
| `pdfPageCount` | 28 | ✅ |
| `indexPageCount` (pdf-books) | 28 | ✅ 28/28 |
| `pdfIndexPageCount` | 28 | ✅ |
| `searchIndexMissing` | 0 | ✅ |
| `fastIndexMissing` | 0 | ✅ |
| `pagesMissingFromIndex` | 0 | ✅ |
| `pagesBeyondPdf` | 0 | ✅ |
| حروف PDF | 45,681 | — |
| حروف `pdf-books.fullText` | **45,681 (متطابقة 100%)** | ✅ لا فقد |
| متوسط تغطية النص (`coverage`) | **1.000** (كل صفحة) | ✅ |
| `lostLines` | **0** | ✅ |
| `textMissingPages` | 0 | ✅ |
| `lowCoveragePages` | 0 | ✅ |
| حروف `search-index.text` | 44,505 | — |
| الفرق | 1,176 = **42 حرفاً × 28 صفحة بالضبط** | ✅ اقتطاع صفر |
| `SEARCH_TEXT_TRUNCATED` | **0** | ✅ |
| `SEARCH_TEXT_LONGER` | 0 | ✅ |
| `searchableMismatch` | 0 | ✅ |
| `TEXT_MISSING_IN_INDEX` | 0 | ✅ |
| `PRINTED_PAGE_MISMATCH` | **28 (كل الصفحات)** | ⚠️ **إنذار كاذب — انظر §5** |
| صفحات بصور بلا figures | **0** | ✅ لا توجد صور أصلاً (0 image في 28/28) |
| صفحات صورة بلا نص | 0 | ✅ |
| `HAS_IMAGES_NO_FIGURES` | 0 | ✅ صحيح |
| `SEARCHABLE_FALSE_BUT_HAS_TEXT` | 0 | ✅ |
| صفحات `.indb` في `fullText` | **28/28** (56 مرة) | ❌ |
| صفحات `.indb` في `search-index.text` | **28/28** (56 مرة) | ❌ |
| تواريخ/أوقات في `fullText` | 28/28 (112 رمزاً، 840 حرفاً) | ❌ |
| تواريخ/أوقات في `search-index.text` | **0** | ✅ |
| `outlineSummary` موجودة | 28/28 (262–587 حرفاً) | ✅ |

### تغطية الحقول الوصفية

| pdf-books | #/28 | | search-index | #/28 |
|---|---|---|---|---|
| `title` | 28 | | `title` | 28 |
| `summary` | 28 | | `summary` | 28 |
| `section` | **17** | | `section` | **17** |
| `unit` | **0** | | `unit` | **0** |
| `pageType` | 28 | | `pageType` | 28 |
| `educationalPurpose` | 28 | | `purpose` | 28 |
| `printedPage` | 28 | | `printedPage` | 28 |
| `lessonRange` | **0** | | `work` | **0** |
| `reviewed` | 28 | | `figures` | 0 |
| `ocr` | 28 | | `activities` | 0 |
| `glossary` | 0 | | `exercises` | 0 |
| `figures` | 0 | | `outlineSummary` | 28 |
| `activities` | **0** | | `preview` / `terms` / `keywords` | 28 / 28 / 28 |
| `exercises` | 0 | | `enriched` | **0 (=false)** |

> `fieldCoverage.enriched = 28` في تقرير deep-audit **مضلِّل**: هو يحسب **وجود المفتاح** لا كونه `true`. القيمة الفعلية `enriched: false` في **28/28**.

---

## 3. خصوصية دليل المعلم — هل الفهرس يعكس نوع الدليل صحيحاً؟

### 3.1 ما هو صحيح (على مستوى الكتاب)
- `referenceKind: "teacher-guide"` و `kind: "teacher-guide"` — ✅ سليم.
- `subject: "دليل المدرس"` — ✅ سليم.
- `sourceProvenance.authority: "supporting-reference"` — ✅ **الكتاب الوحيد** الـ21 الذي يحمل هذه القيمة؛剩下的 كلها `official-reference`. هذا تمييز صحيح ودقيق.
- `supplementary: false` مع `supplementary` غير موجود في pdf-books — تفصيل ثانوي.

### 3.2 ما هو خاطئ (على مستوى الصفحة) — الفجوة المعرفية الكبرى

**الفهرس لا يميّز صفحة الدليل عن صفحة كتاب الطالب في `pageType`.** enum المسموح به (من `curriculum-library/enrichment/SCHEMA.md:31`) لا يحوي أي قيمة تعبّر عن «تعليمات تدريس»، فسقطت الصفحات في `exercises`:

- **18/28 صفحة** مُصنّفة `exercises`، منها **13 من أصل 14** صفحة «مفتوحة» (تحتوي ترويسة `Objectives` + `Vocabulary` + `Stage 1…N` + `Answers`) — أي **93% من خطط الدروس مُسمّاة تمارين**.
- صفحة فيزيائية 1 (`Guidance notes for Literature Focus` — إرشادات عامة للمعلم، بلا أي تمرين) مُصنّفة **`exercises`**؛ و`educationalPurpose`Become «تطبيق المفاهيم والتدرب على نمط الأسئلة».
- نص الصفحة الفعلية هو **تعليمات**، لا تمارين: `Ask students` **68 مرة**، `groups of three or four` **25 مرة**، `Put students into groups`، `Walk around the room to monitor`. مثال صفحة فيزيائية 5: «Explain the task and ask students to find words… • Correct as a whole class.» هذا 100% دليل معلم.

**عدم اتساق داخلي مثبت بالأرقام (ليس تقديراً):**

| الحالة | البرهان المقيس |
|---|---|
| الصفحتان المتناظرتان «Introduction» | فيزيائية 3 → `exercises`، فيزيائية 16 → `lesson_content` (بنية متطابقة) |
| نفس عدد الحروف | فيزيائية 16 = 2,323 حرفاً → `lesson_content`؛ فيزيائية 25 = **2,323 حرفاً** → `exercises` |
| صفحات الـ «opener» ذات الترويسة `Objectives` | 14 صفحة (3,4,6,8,10,12,14,16,17,19,21,23,25,27) → 13 `exercises` + 1 `lesson_content` |

**`educationalPurpose` قالب مكرر بنسبة 100%:** قيمتان فقط، ومجموعة الصفحات لكل قيمة **مطابقة تماماً** لمجموعة `pageType`:

| القيمة | عدد الصفحات | الصفحات | = pageType |
|---|---|---|---|
| تطبيق المفاهيم والتدرب على نمط الأسئلة. | 18 | 1,3,4,5,6,7,8,10,11,12,14,17,19,20,21,23,25,27 | `exercises` بالضبط |
| قراءة التعريفات والأمثلة والمحتوى التعليمي. | 10 | 2,9,13,15,16,18,22,24,26,28 | `lesson_content` بالضبط |

⇒ **معلومات حافية (marginal) = صفر.** الحقل لا يضيف شيئاً على `pageType`، ويفشل في نقل وظيفته الحقيقية: أن يقول للمعلم **لماذا** تُستخدم الصفحة (تمهيد؟ تقويم؟ مفتاح إجابات؟).

### 3.3 المعلومات الفريدة للدليل — ما منها مفهرس وما منها مفقود

| معلومة الدليل | في PDF؟ | في fullText؟ | منظّمة في الفهرس؟ |
|---|---|---|---|
| 68 تعليمة «Ask students…» | ✅ | ✅ (نص حر) | ❌ `activities` = 0/28 |
| مفتاح الإجابات (24 صفحة فيها `Answers`) | ✅ | ✅ | ❌ `answerKeyLocation` = 0/28 |
| 13 كتلة `Vocabulary` مطبوعة | ✅ | ✅ | ❌ `vocabulary` = 0/28 |
| 14 كتلة `Objectives` | ✅ | ✅ | ❌ `lessonRange` = 0/28 |
| 95 تسمية `Stage N` (1..8) | ✅ | ✅ | ❌ |
| 77 إحالة `SB` + 72 إحالة `AB` | ✅ | ✅ | ❌ |
| 7 مبادئ القراءة الممتدة (ص1) | ✅ | ✅ | ⚠️存在于 outline فقط |
| توزيع الوحدات Unit 1–7 (ص1) | ✅ | ✅ | ❌ `unit` = 0/28 |
| `Literature Focus` / `Jane Austen` / `William Shakespeare` | ✅ | ✅ | ❌ `unit`/`work`/`author` = 0/28 |
| **Timings / زمن الحصة** | ❌ **غير موجود في PDF إطلاقاً** (0 `mins`، 0 `minutes`، 0 `timing`) | — | — غير فجوة |

> **التحقق السلبي المهم:** لا يوجد أي timing في هذا PDF. أي تقرير يدّعِ أن الفهرس أسقط الـ timings يكون مُخطئاً؛ لا timings في الأصل. كما أن الـ outline لا يختلق timings (تحققت).

**الخلاصة:** الـ outline `.md` (50,843 حرفاً) هو **المصدر الوحيد** الذي يعكس نوع الدليل بشكل صحيح: فيه «قواعد الاستشهاد لهذا الكتاب» الصريحة («هذا دليل للمعلم… لا أسئلة للطالب») وفيه خريطة 15 كتلة، وفيه عدّ الـ 7 مبادئ للقراءة الممتدة (تحققت: **7 نقط فعلاً** في PDF ص1 ✅). كل هذا **غير منقول** إلى `pdf-books` ولا إلى `search-index` إلا في `outlineSummary` مقصوصاً (~300 حرف).

---

## 4. اكتمال النص + الاقتطاع

### 4.1 التطابق مع PDF — ممتاز
- `pdf-books.fullText` = 45,681 حرفاً = **مجموع نص PDF المستخرج بالضبط** (chars متطابقة صفحة بصفحة، 28/28).
- `coverage = 1.000` في **28/28** صفحة، `lostLines = 0` — **لا سطر مفقود واحد** في الكتاب كله.
- `lostLines > 0` أو `coverage < 1`: **لا يوجد أي صفحة**. لا حاجة لفتح page-compare بسبب هذه المسألة.

### 4.2 الاقتطاع في `search-index` — صفر اقتطاع (مثبت حسابياً)
- الفرق = 1,176 حرفاً موزّعاً **بالتساوي تماماً: 42 حرفاً في كل صفحة من الـ28** (لا استثناء).
- التفكيك: `stripLeadingFolio` + `stripTrailingFolio` في `scripts/build-index.mjs:198` يحذفان:
  1. `178 178 ` في رأس النص (8 أحرف) — في 27/28 صفحة (في ص1 يبدأ بـ `Appendix A` أصلاً فلا حذف).
  2. `04/08/2025 04/08/2025 14:11 14:11` في التذييل (34 حرفاً).
- **الاختبار الحاكم لدليل المعلم:** المقتطع هنا **حروف المصنع + التواريخ + تكرار رقم الصفحة** فقط — أي مطابق تماماً لمعيار الدليل. ⇒ **لا اقتطاع في محتوى المعلم إطلاقاً.** ✅
-Timestamp/date: 112 رمزاً في `fullText` → **0** في `search-index.text`. ✅

### 4.3 الضجيج المصنع `.indb` — غير مُزال في الطبقتين (عيب حقيقي)
- `IRAQ_G12_TB_2025_EXTENDED.indb` يظهر **مرتين في كل صفحة** = **56 مرة في 28/28 صفحة**.
- باقٍ في `pdf-books.fullText` **و** في `search-index.text` **و** في `normalized`.
- **أثر على وقت التشغيل (مقيس):** `postings.indb` existe في `search-index.json` بـ `df = 99` (99 وثيقة من 2,342)، وكل وثائق كتابنا الـ28 تحمله.
- `scripts/build-index.mjs` فيه حارس `indb|iraq_g12` في `pageTitle` (س100) و`pageSummary` (س111/117) — **لكن ليس** في `stripLeadingFolio/stripTrailingFolio` ولا في `text` النهائي. التسريب محصور ومحدَّد.
- تسرّب إضافي: `.indb` ×13 في `outlines/<bookId>.md`، و**2 من 28** حقل `outlineSummary` يحمل النص المقطوع `…IRAQ_G12_TB_2025_EXTENDED.i` (مثال صفحة فيزيائية 5).

---

## 5. `printedPage` / `searchable` — الحكم على الأعلام

### 5.1 `PRINTED_PAGE_MISMATCH` × 28 → **إنذار كاذب بالكامل (0 عيوب حقيقية)**

السبب: كاشف الفحص في `deep-audit.mjs` يقرأ **سطرين أعلى الصفحة وسطرين أسفلها** (`printedCandidates` س114-118) ويستخرج **أرقاماً مستقلة** متتالية (`printedFromLines` س101-113). في هذا الـ PDF:

- رقم الصفحة المطبوع **موجود فعلاً** في كل صفحة، **مطابق تماماً** لـ `printedPage`:
  - **بداية النص المستخرج** لكل صفحة من الـ28 تحمل الرقم المزدوج المطابق تماماً (`178 178` … `205 205`). تحققت صفحةً صفحة: `1=178/pp178`، `2=179/pp179`، … `28=205/pp205` — **28/28 مطابقة، صفر انحراف**.
  - ويظهر مرة ثانية في سطر التذييل مع `04/08/2025 …`.
- الكاشف أرجع `printedInPdf: []` (فارغ) لـ26 صفحة، و`[4]` / `[3]` / `[5]` في ص11/21/27 — وهذه **أرقام بنود تمارين**، لا أرقام صفحات.

**البرهان التشغيلي القاطع:** `lib/index.mjs → locate('english-literature-teacher-guide-95722f85-pdf', 189)` يُرجع **12** → صفحة فيزيائية 12 = المطبوعة 189 = بداية `Pride and Prejudice Section 5`. ✅ والملف `fast-index.printed` يحمل الخريطة كاملة `178→1 … 205→28`، وكذلك `search-index.printed`. ⇒ **الرقم صحيح، مجرّب، والكاشف هو العطب.**

### 5.2 `searchable` / `ocr` — سليمة تماماً
- `searchable: true` في 28/28 (مطابقة لـ `searchableMismatch = 0`).
- `needsOcr: false` + `ocr.status: "text"` + `ocr.required: false` في 28/28.
- `search-index.searchablePages = 2,246` من 2,342، و`visionPageCount` لكتابنا = **0**. لا صفحة مصوّرة.
- `LOW_COVERAGE` / `SEARCHABLE_TRUE_BUT_NO_GLYPHS` / `IMAGE_PAGE_NO_TEXT`: **0**. كل صفحة فيها 29–214 glyph حقيقي.
- ⇒ **لا صفحة `printedPage == null`**، فلا حاجة لاستخراج أي رقم. (كل الـ28 لها رقم مطبوع ومضبوط.)

---

## 6. دقة الحقول الوصفية — فحص 28/28 صفحة

### 6.1 جدول التقييم الكامل

| فيزيائية | مطبوعة | `title` (pdf-books) | تقييم title | `pageType` | التقييم الفعلي لصفحة الدليل | `summary` يغطي الصفحة؟ | `section` | `educationalPurpose` |
|---|---|---|---|---|---|---|---|---|
| 1 | 178 | Appendix A: Guidance notes for Literature Focus | ✅ دقيق | `exercises` | ❌ **إرشادات عامة للمعلم** | ⚠️ جزئي — يُغفل 7 مبادئ القراءة الممتدة + تدفّق الدرس + الإرشاد للقاموس/القراءة الصامتة | ❌ null (والمطبوعة فيها `Unit 1: Section 1 and 2` … `Unit 7: Section 5 and 6`) | ❌ قالب خاطئ |
| 2 | 179 | Professional Development and reflection support… | ⚠️ العنوان **مبني على استنتاج**؛ الصفحة أصلاً **لا ترويسة** (تكملة «Notes on using the readers») | `lesson_content` | ✅ مقبول | ✅ كامل (587 حرف) | ❌ null | ❌ قالب |
| 3 | 180 | Pride and Prejudice Introduction: objectives, icebreaker… | ✅ دقيق وم distinguishing | `exercises` | ❌ خطة درس (Stage 1–4) | ⚠️ جزئي — يُغفل مفردات `worsened/anonymously/delightful/chaotic` + ملاحظة «لا تمارين Activity Book، كل شيء شفوي» + Stage 3 + Stage 4 | ✅ `Pride and Prejudice Introduction` | ❌ قالب |
| 4 | 181 | Pride and Prejudice Section 1: reading a literary extract and checking gist | ⚠️ يُغفل Stage 5 | `exercises` | ❌ خطة درس (Stage 1–5) | ❌ **ناقص** — يُغفل 6 مفردات + **3 مفاتيح إجابات** + Stage 5 | ✅ `Pride and Prejudice Section 1` | ❌ قالب |
| 5 | 182 | Understanding vocabulary from context and predicting the novel's next events | ✅ دقيق جداً | `exercises` | ⚠️ صفحة إجابات + Stage 6–8 | ✅ جيد (يوصف المرحلتين 6 و8) | ❌ **null** — لكنها متابعة Section 1 | ❌ قالب |
| 6 | 183 | P&P Section 2: reading for gist and detail | ✅ | `exercises` | ❌ خطة درس | ⚠️ جزئي | ✅ | ❌ قالب |
| 7 | 184 | Matching questions to characters and writing a dialogue activity | ✅ | `exercises` | ⚠️ تمارين مطابقة + كتابة | ✅ | ✅ | ❌ قالب |
| 8 | 185 | P&P Section 3: sequencing events and matching | ✅ | `exercises` | ❌ خطة درس | ⚠️ جزئي | ✅ | ❌ قالب |
| 9 | 186 | Writing a Short Letter as Elizabeth Bennet… | ✅ | `lesson_content` | ✅ | ✅ كامل (484 حرف) | ❌ **null** | ❌ قالب |
| 10 | 187 | P&P Section 4: Warm-Up, Story Summary and Reading for Gist | ✅ | `exercises` | ❌ خطة درس | ⚠️ جزئي | ❌ **null رغم أن النص يطبع `Section 4`** | ❌ قالب |
| 11 | 188 | Vocabulary from Context Practice and Letter Writing as the Late Mr Darcy | ✅ | `exercises` | ⚠️ تمارين | ⚠️ جزئي | ❌ **null** | ❌ قالب |
| 12 | 189 | P&P Section 5: Story Summary, Reading for Gist and Detail | ✅ | `exercises` | ❌ خطة درس | ⚠️ جزئي | ❌ **null رغم `Section 5`** | ❌ قالب |
| 13 | 190 | Word Pronunciation Practice and Letter Writing as Elizabeth Bennet to Wickham | ✅ | `lesson_content` | ✅ | ✅ | ❌ **null** | ❌ قالب |
| 14 | 191 | P&P Section 6: Story Summary, Sequencing Events and Detailed Reading | ✅ | `exercises` | ❌ خطة درس | ⚠️ جزئي | ❌ **null رغم `Section 6`** | ❌ قالب |
| 15 | 192 | Vocabulary Answer Key and Letter Writing as Mr Darcy Announcing News | ✅ | `lesson_content` | ✅ | ✅ | ❌ **null** | ❌ قالب |
| 16 | 193 | As You Like It Introduction: About the Play, William Shakespeare and Initial Predictions | ✅ | `lesson_content` | ✅ (نعم، خطأ التناسق مع ص3) | ⚠️ جزئي | ❌ **null** | ❌ قالب |
| 17 | 194 | AYLI Section 1: Objectives, Vocabulary, Warmer, Story Summary, Literary Extract… | ⚠️ **124 حرفاً** (> حد 90) | `exercises` | ❌ خطة درس (7 مراحل) | ❌ **ناقص** — يُغفل Stages 5,6,7 + **4 مفاتيح إجابات** | ⚠️ `As You Like It` (بلا رقم قسم) | ❌ قالب |
| 18 | 195 | Vocabulary Answers for AYLI Section 1 and Predictive Writing Activity | ✅ | `lesson_content` | ✅ | ✅ | ⚠️ بلا رقم قسم | ❌ قالب |
| 19 | 196 | AYLI Section 2: Objectives, Vocabulary, Warmer… | ⚠️ **112 حرفاً** | `exercises` | ❌ خطة درس | ⚠️ جزئي | ⚠️ بلا رقم | ❌ قالب |
| 20 | 197 | Summary Completion and Play Scene Writing Activities for AYLI Section 2 | ✅ | `exercises` | ⚠️ تمارين | ✅ | ⚠️ بلا رقم | ❌ قالب |
| 21 | 198 | AYLI Section 3: Objectives, Vocabulary, Warmer… True-False | ⚠️ **105 أحرف** | `exercises` | ❌ خطة درس | ❌ ناقص — **بلا ذكر لأي إجابة** | ⚠️ بلا رقم | ❌ قالب |
| 22 | 199 | Sentence Ordering and Play Scene Writing for AYLI Section 3 | ✅ | `lesson_content` | ✅ | ✅ | ⚠️ بلا رقم | ❌ قالب |
| 23 | 200 | AYLI Section 4: Objectives, Vocabulary, Warmer… Event Ordering | ⚠️ **101 حرف** | `exercises` | ❌ خطة درس | ⚠️ جزئي | ⚠️ بلا رقم | ❌ قالب |
| 24 | 201 | Vocabulary Answers and Creative Letter Writing for AYLI Section 4 | ✅ | `lesson_content` | ✅ | ✅ | ⚠️ بلا رقم | ❌ قالب |
| 25 | 202 | AYLI Section 5 — Warm-up, Story Summary… | ✅ | `exercises` | ❌ خطة درس | ⚠️ جزئي | ⚠️ بلا رقم | ❌ قالب |
| 26 | 203 | AYLI Section 5 — Sequencing Events and Writing a Letter from Oliver | ✅ | `lesson_content` | ✅ (تناقض مع ص25!) | ✅ | ⚠️ بلا رقم | ❌ قالب |
| 27 | 204 | AYLI Section 6 — Warm-up, Story Summary, True/False… | ⚠️ **92 حرفاً** | `exercises` | ❌ خطة درس | ⚠️ جزئي | ⚠️ بلا رقم | ❌ قالب |
| 28 | 205 | AYLI Section 6 — Letter Writing: Duke Frederick… | ✅ | `lesson_content` | ✅ | ✅ | ⚠️ بلا رقم | ❌ قالب |

### 6.2 الأحكام المقيسة علىFXCol

**(أ) `title`**
- جودة وصفية جيدة جداً: **28/28** عنوان يصف محتوى الصفحة فعلياً، و**مميّز** — لا يوجد أي عنوان مكرر بين الـ28. عيّنات: ص5 «Understanding vocabulary from context and predicting the novel's next events»، ص9 «Writing a Short Letter as Elizabeth Bennet After Overhearing a Conversation».
- **إخلال 1 — خرق حدّ الطول:** `SCHEMA.md:32` يفرض 10–90 حرفاً. **6/28** تتجاوز: ص17=124، ص19=112، ص21=105، ص23=101، ص27=92، ص28=98 (الحد الأقصى **124**).
- **إخلال 2 — اللغة:** `SCHEMA.md:32,34` تفرض `title` و`summary` **بالعربية**. المقيس: **0/28** عنوان بالعربية؛ **20/28** ملخص بالإنجليزية (8 عربية فقط). الكتاب الشقيق `english-literature-exercises-sixth-pdf` ملتزم (مثال حقيقي: `قسم 5 تمارين: أربعة أسئلة اختيار من متعدد…`) ⇒ **المشروع يلتزم المعيار، وهذا الكتاب استثناء**.
- **إخلال 3 — عيب حرج في طبقة وقت التشغيل:** `search-index.title` **مبتور في منتصف كلمة** في صفحة فيزيائية 1 (140 حرفاً بالضبط):
  > `` `Appendix A — Guidance notes for Literature Focus` يتبعه قسم فرعي `Notes on using the readers`، ويحتوي على: أهداف التعلّم الأساسية لوحدة Lit ``

  السبب: `scripts/build-index.mjs:98` → `outlineTitle.slice(0, 140)`. النص ليس عنواناً أصلاً بل وصف مُقتطع.

**(ب) `section` — العيب البنياني الأخطر**
- **17/28** فقط. الصفحات الفارغة: **1, 2, 5, 9, 10, 11, 12, 13, 14, 15, 16**.
- **3 صفحات فارغة رغم أن نصها يطبع اسم القسم صراحةً**: ص10 يطبع `Section 4`، ص12 `Section 5`، ص14 `Section 6`.
- **القيم لا تطابق `SCHEMA.md:28`** («انسخه حرفياً: `Section 1` … `Section 6»): القيم الفعلية مركّبة من 5 أشكال مختلفة فقط:
  `null` | `Pride and Prejudice Introduction` | `Pride and Prejudice Section 1` | `Pride and Prejudice Section 2` | `Pride and Prejudice Section 3` | `As You Like It`
  ⇒ **لا `sectionPath`**، فيصبح `Section 3` في P&P و `Section 3` في AYLI **غير قابلين للتمييز** (وهذا ما يُفسد الاسترجاع في §10).

**(ج) `summary` — «يغطي كامل الصفحة لا أولها» (المخالفة مُقيسة)**
انتهاك `SCHEMA.md:34` مقيساً بأرقام:

| الفحص | Pages with the feature in text | Summaries that mention it | **المُ omissions** |
|---|---|---|---|
| مفاتيح الإجابات (`Answers`) | **24** | 13 | **11 صفحة تُسقط الإجابات** |
| كتل `Vocabulary` | **13** | 6 | **7 صفحات تُسقط المفردات** |
| ترقيم `Stage N` | **26** | 4 | **22 صفحة لا تذكر أي مرحلة** |
| التغطية | | | |

- **27/28** ملخص يتجاوز حدّ 200 حرف (`SCHEMA.md:34`)؛ الحد الأقصى **323** (ص1).
- أمثلة缺失 صريحة: **ص17** (7 مراحل + 4 مفاتيح إجابات) ملخصها يتوقف عند «detail-focused exercises»؛ **ص4** (3 مفاتيح إجابات + 6 مفردات) ملخصها لا يذكر كلمة «إجابة» ولا كلمة «مفردات»؛ **ص21** ملخصه لا يذكر أي إجابة.
- ⇒ النمط **منتظم ومقيس**: انحياز الملخصات إلى **بداية الصفحة**، مع إسقاط متعمّد/آلي لأقرب جزء valuable للمعلم (مفاتيح التصحيح).
- **إشادة:** `summary` متطابقة **0/28 اختلاف** بين `pdf-books` و `search-index` ⇒ لا تعارض بين الطبقتين هنا. ✅

**(د) `reviewed`**
- `reviewed: true` في **28/28** رغم أن 22/26 صفحة لا يغطي ملخصها أي مرحلة تدريس. ⇒ **العلامة غير جديرة بالثقة** ولم تُراجَع يدوياً بالمعنى الذي توحي به.

**(هـ) `pageType`** — راجع §3.2: 18 `exercises` / 10 `lesson_content`، مع 3 تناقضات مثبتة أرقاماً.

**(و) `educationalPurpose`** — راجع §3.2: قيمتان، ارتباط تام بـ`pageType`، معلومة حافية صفر.

**(ز) `unit` / `work` / `author`** — **0/28** في الطبقتين، رغم_printing في PDF: ص1 تطبع `Literature Focus` و `Unit 1: Section 1 and 2` … `Unit 7: Section 5 and 6`؛ ص3 `Jane Austen`؛ ص16 `William Shakespeare`. و`SCHEMA.md:25-27` يوفّر الحقول الثلاثة صراحةً لهذا الغرض.

**(ح) `lessonRange`** — **0/28**، بينما في النص 14 كتلة `Objectives` و77 إحالة `SB` و72 إحالة `AB`.

---

## 7. معلومات PDF غائبة عن الفهرس

- **`HAS_IMAGES_NO_FIGURES` = 0، و`pagesWithImages` = 0.** تحقق مباشر: **0 عملية رسم صورة في أي من الـ28 صفحة** (`paintImageXObject`/Jpeg/InlineImage/ImageMask/Repeat = لا شيء). **لا يوجد جدول ولا مخطط ولا رسم فني مفقود** — لا فجوة من هذا النوع. ✅
- العناصر الجدولية الوحيدة في الكتاب **مكتوبة كنص** وقد سُجّلت كاملة في `fullText`:
  1. **ص1** — جدول توزيع الوحدات: `Pride and Prejudice: Unit 1: Section 1 and 2 / Unit 2: Section 3 and 4 / Unit 3: Section 5 and 6` ثم `As You Like It: Unit 5: Section 1 and 2 / Unit 6: Section 3 and 4 / Unit 7: Section 5 and 6` ⇒ **حاضرة في النص، غائبة تماماً عن `unit` (0/28) وفي `outlineSummary` المقطوع**.
  2. **ص1** — 4 أهداف تعلّم رئيسية بنصها + 7 مبادئ قراءة ممتدة ⇒ حاضرة في النص، والمقتطف العربي في `outlineSummary` يذكر «السبعة» (تحققت: 7 فعلاً ✅) لكن **بقية المبادئ الستة غير موجودة في أي حقل عربي**.
  3. **ص3** — ملاحظة «لا تمارين Activity Book لقسم Introduction، كل تمارين كتاب الطالب تُنفَّذ شفوياً» ⇒ في النص، **مفقودة تماماً** من `summary` و `outlineSummary`.
  4. **مفاتيح الإجابات** (24 صفحة) ⇒ في النص، **غير مُهيكل** (`exercises` = 0، `answerKeyLocation` = 0).

---

## 8. الطبقات والتحديث

| الطبقة | الحالة | التفصيل المقيس |
|---|---|---|
| `pdf-sources/*.pdf` | ✅ سليم | 21 ملف، `checksum` = `79f217b2…` |
| `pdf-books/*.json` | ✅ v2، 28/28 | `fullText` متطابق 100% |
| `pdf-index.json` | ✅ v2، 21 كتاباً | مدخل الكتاب مطابق لـ pdf-books |
| `search-index.json` | ✅ v4، 21 كتاباً / **2,342 وثيقة**، `builtAt` = 2026-09-28 | `sourceOfTruth` = `curriculum-library/pdf-sources` ✅، `outlinePages` = 2,342 (كتابنا 28/28 ✅) |
| `fast-index.json` | ⚠️ **قديمة فعلاً** | `version: 1`، **12 كتاباً فقط** من 21، **1,456 صفحة** من 2,342 ⇒ تغطي **55%** من الفهرس. كتابنا موجود فيها (28 صف) وبها خريطة `printed` كاملة `178→1 … 205→28` ⇒ **طبقة موازية مكرّرة** خطر تضارب |
| `outlines/*.md` | ✅ 21 ملف = 21 كتاب 1:1 | كتابنا **50,843 حرفاً** — أغنى طبقة في المشروع لهذا الكتاب |
| `enrichment/*.json` | ❌ **مفقود** | 3 ملفات فقط (`SCHEMA.md` + كتابان: `english-literature-sixth-pdf`، `english-literature-exercises-sixth-pdf`). `search-index.stats`: `enrichedBooks: 2` من 21، `enrichedPages: 53` ⇒ كتابنا خارج التغطية |
| `catalog.json` | ⚠️ **فارغ** | `books: 0` بينما `pdf-index`/`search-index` فيهما **21**. خلل على مستوى المشروع لا الكتاب، لكنه يمسّ اكتشاف الكتب |

**إضافات على مستوى الوقت التشغيل (من `lib/index.mjs`):**
- `STRUCTURED_KEYS` (س20) يقرأ `unit, work, author, section, sectionPath, actScene, activities, exercises, answerKeyLocation, recapOf, …` ⇒ **كلها فارغة لكتابنا** ⇒ مسار الاستدعاء المنظّم معطّل كلياً لهذا الكتاب.
- `printedPageGaps: 91` في `getHealth()` — لا يعمل لكتابنا (0 فجوة من 28).

**تعارض مصدرين لعنوان الصفحة (مقيس):**
`search-index.title` ≠ `pdf-books.title` في **15/28** صفحة. السبب: `build-index.mjs:97-98` يفضّل `outlinePage.title` (العنوان المطبوع الحرفي) على `page.title` (الوصف المولَّد). النتيجة: **طبقة وقت التشغيل تخلط دلالتينdifferent للعنوان** — وفي 13 صفحة عنوانها نص مطبوع بين قوسين مع إحالات SB/AB (`Appendix A Pride and Prejudice Section 1 SB100–101 AB168–169`)، بينما الـ13 الباقية عنوانها وصفي. والحالة الأسوأ: **ص1** — وصف مبتور في منتصف كلمة.

---

## 9. جدول الفجوات بالخطورة + الإصلاح المقترح

| # | الخطورة | الفجوة | البرهان المقيس | الإصلاح المقترح |
|---|---|---|---|---|
| G1 | **حرج** | `unit`/`work`/`author` = **0/28** رغم طباعتها في PDF | استعلام «الأهداف التعليمية للوحدة الأولى» ⇒ **0 نتيجة** من دليل المعلم؛ النص يطبع `Literature Focus`/`Unit 1..7`/`Jane Austen`/`William Shakespeare` | إنشاء `enrichment/english-literature-teacher-guide-95722f85-pdf.json` وملء `unit` (literature focus / الوحدة 1..7 كما مطبوعة)، `work`، `author` لكل صفحة — الحقول موجودة في `SCHEMA.md:25-27` |
| G2 | **حرج** | `section` ناقصة وغير حرفية ⇒ **سؤال المعلم الأساسي يفشل** | «ما الأهداف لـ Section 5 من P&P؟» ⇒ الصفحة الصحيحة **فيزيائية 12** تأتي **خامساً** بدرجة **43.7** **مطابقة تماماً** لـ4 صفحات خاطئة (ص4,6,8,10)؛ و`section` = null في ص10/12/14 رغم طباعة `Section 4/5/6` | ملء `section` حرفياً (`Section 1`…`Section 6`) + `sectionPath` (`Literature Focus > Pride and Prejudice > Section 5`) في **28/28** — يميّز P&P عن AYLI ويفك التعادل |
| G3 | **حرج** | لا ملف `enrichment` ⇒ ضياع البنية الخاصة بالدليل | `activities`=0 (68 تعليمة «Ask students») · `answerKeyLocation`=0 (24 صفحة فيها `Answers`) · `vocabulary`=0 (13 كتلة) · `lessonRange`=0 (77 SB + 72 AB) · `sectionPath`=0 | نفس ملف G1: تغذية بصرية لـ 28 صفحة وفق `SCHEMA.md:55-72` (خصوصاً `activities[].instruction` الحرفي و`answerKeyLocation`) |
| G4 | **حرج** | `search-index.title` مبتور في منتصف كلمة (ص1) | `` …يحتوي على: أهداف التعلّم الأساسية لوحدة Lit `` (140 حرفاً) — `build-index.mjs:98` `slice(0,140)` | قصّ على حد **كلمة** لا حرف، أو استخدام `page.title` الوصفي، أو توسيع `SCHEMA.md` بقيمة `titleOutline` منفصلة |
| G5 | **عالٍ** | `educationalPurpose` قالب مكرر — معلومة حافية صفر | قيمتان فقط: **18** و**10**؛ المجموعتان = `pageType` حرف بحرف | استبدال القالب بـ 4–6 قيم تعبّر عن وظيفة الدليل: `إرشادات عامة للمعلم` · `خطة درس (مراحل)` · `مفتاح إجابات وتصحيح` · `نشاط إنتاجي/كتابي` · `مفردات في سياق` |
| G6 | **عالٍ** | `pageType` خاطئ دلالياً لدليل معلم + غير متسق داخلياً | 13 من 14 «opener» = `exercises`؛ ص3 `exercises` مقابل ص16 `lesson_content`؛ ص16 (2,323 حرفاً) `lesson_content` مقابل ص25 (**2,323 حرفاً**) `exercises`؛ ص1 (إرشادات) = `exercises` | إضافة قيمة `teacher_notes`/`lesson_plan` إلى enum في `SCHEMA.md:31`، أو اعتماد تمييز بنيوي موثّق: صفحة فيها `Objectives`+`Stage` ⇒ `lesson_plan`، بلا Objectives ⇒ `teacher_notes` |
| G7 | **عالٍ** | `summary` لا يغطي كامل الصفحة (المخالفة لـ `SCHEMA.md:34`) | 22/26 صفحة بلا ذكر أي `Stage` · 11/24 تُسقط مفتاح الإجابات · 7/13 تُسقط المفردات · 27/28 تتجاوز حد 200 حرف (الأقصى 323) | إعادة توليد `summary` بقاعدة **إلزامية تغطية**: تسمية كل `Stage N` + وجود `Answers` + عدد المفردات؛مثال إجباري لص4: «3 مفاتيح إجابات (Ex A: 6 عبارات صح/خطأ، Ex B: 7 إجابات)» |
| G8 | **عالٍ** | ضجيج `.indb` داخل نص البحث | 56 مرة في 28/28 صفحة في `pdf-books.fullText` **و** `search-index.text`؛ `postings.indb` بـ`df=99` | توسيع `stripTrailingFolio`/`stripLeadingFolio` (`build-index.mjs:198`) لحذف `[\w-]*\.indb` — الحارس موجود أصلاً في `pageTitle`/`pageSummary` وسينتقل تلقائياً |
| G9 | **عالٍ** | تعارض العنوان بين الطبقتين في 15/28 صفحة | ص3: pdf-books = `Pride and Prejudice Introduction: objectives, icebreaker…` / search = `` `Appendix A Pride and Prejudice Introduction SB98–99` ``؛ ومجموعة القيمتين متمايزة تماماً | unify: اعتمد `page.title` الوصفي في `title`، وانقل العنوان المطبوع إلى حقل `headingPrinted` جديد (يحمل إحالات SB/AB بشكل صحيح) |
| G10 | **متوسط** | التواريخ/الأوقات باقية في `pdf-books.fullText` | 112 رمزاً (840 حرفاً) في 28/28؛ `search-index` حذفها ⇒ **سياسة ضجيج غير متسقة بين طبقتين** | تطبيق نفس منطق `stripTrailingFolio` على pdf-books، أو توثيق أن pdf-books خام عمداً |
| G11 | **متوسط** | خرق حدود الطول في `SCHEMA.md` | `summary` > 200 حرف في **27/28** (الأقصى 323)؛ `title` > 90 حرف في **6/28** (الأقصى 124)؛ `search-index.title` > 90 في ص1 (140) وص28 (98) | فرض الحد آلياً في `build-index.mjs` مع تحذير بدل القطع الصامت |
| G12 | **متوسط** | خرق قاعدة اللغة العربية (`SCHEMA.md:32,34`) | **0/28** `title` بالعربية · **20/28** `summary` بالإنجليزية | تعميم معيار الكتاب الشقيق `english-literature-exercises-sixth-pdf`؛ إضافة `titleEn`/`summaryEn` |
| G13 | **متوسط** | `reviewed: true` غير جدير بالثقة | 28/28=true رغم أن 22/26 صفحة ملخصها لا يغطي أي مرحلة | ضبط `reviewed` على نتيجة فحص آلي (تغطية Summary) لا على قيمة ثابتة |
| G14 | **متوسط** | `fast-index.json` طبقة قديمة مكرّرة | `version: 1`، 12 كتاباً من 21 (57%)، 1,456 صفحة من 2,342 (62%)؛ تحمل نسخة ثانية من خريطة `printed` لكتابنا | إمّا حذفها أو توليدها من نفس المصدر/النسخة، أو وسمها `deprecated: true` لمنع القراءة منها |
| G15 | **متوسط** | `catalog.json` فارغ | `books: 0` مقابل 21 في `pdf-index`/`search-index` | إعادة توليد `catalog.json` من `pdf-index` (خلل مشروع لا كتابي) |
| G16 | **متوسط** | استعلام عربي حول páginas المقابلة في كتاب الطالب يفشل | «في أي صفحة من كتاب الطالب يقابل القسم 5 من As You Like It؟» ⇒ **0 نتيجة** من دليل المعلم (يرجع لكتاب الأنشطة). السبب: `SB122–123` موجود كنص إنجليزي لكن السؤال عربي | بعد G3: `lessonRange`/حقل `studentBookPages` منظّم + تعريب `terms` بـ`titleEn`/`summaryEn` + مرادفات `SB`↔«كتاب الطالب» |
| G17 | **منخفض** | `.indb` مسرّب إلى الـ outline | 13 مرة في `outlines/<bookId>.md`؛ **2 من 28** `outlineSummary` يحمل `…IRAQ_G12_TB_2025_EXTENDED.i` | نفس إصلاح G8 على مستوى المولِّد |
| G18 | **منخفض** | خطأ مطبعي في خريطة الـ outline | `AYLI Section 4 \| 23–23` والصحيح `23–24` (ص23→pp200، ص24→pp201) | تصحيح السطر |
| G19 | **منخفض** | `figures`/`glossary` = 0/28 | **محققة لا كاذبة**: 0 صورة في 28/28 صفحة؛ لا يوجد كتلة Glossary مطبوعة (الدليل يحيل إلى قاموس كتاب الطالب) | لا إجراء |

**عدّ الفجوات: حرج 4 · عالٍ 4 · متوسط 6 · منخفض 5 = 19 فجوة** (منها `G19` موثّقة كـ«ليست فجوة»).

---

## 10. نسبة الاكتمال (0–100%) وحكم نهائي

### 10.1 حساب مفصّل (مرجّح، مجموع الأوزان = 100)

| المكوّن | الوزن | الدرجة | المساهمة | أساس الدرجة (مقيس) |
|---|---|---|---|---|
| دقة النص مقابل PDF | 20 | **100%** | 20.00 | 45,681 = 45,681 حرفاً · `coverage`=1.000×28 · `lostLines`=0 |
| سلامة `search-index.text` وقت التشغيل | 15 | **96%** | 14.40 | اقتطاع صفر (42 حرفاً/صفحة = folio+timestamps فقط) · **لكن** `.indb` باقٍ في 28/28 و`df=99` عالمياً |
| `printedPage` / الملاحة | 10 | **100%** | 10.00 | 28/28 مطابقة · offset ثابت 177 · `locate(189)→12` مُختبَر |
| الطبقات والتحديث | 10 | **70%** | 7.00 | 6 طبقات سليمة · **لا enrichment** · `fast-index` قديمة (12/21) · `catalog.json` فارغ |
| دقة `title` | 10 | **40%** | 4.00 | 28/28 مميّز ودقيق · لكن 0/28 عربي · 6/28 تجاوز الطول · 15/28 تعارض مع search · ص1 مبتور |
| تغطية `summary` | 10 | **40%** | 4.00 | 22/26 بلا ذكر مرحلة · 11/24 بلا إجابات · 7/13 بلا مفردات · 27/28 تجاوز الطول · 20/28 إنجليزي |
| دقة `section` | 8 | **40%** | 3.20 | 17/28 فقط · غير حرفي · بلا `sectionPath` ⇒ تعادل استرجاع مثبت |
| `unit` / `work` / `author` | 7 | **0%** | 0.00 | 0/28 رغم الطباعة في PDF |
| دقة `pageType` | 5 | **30%** | 1.50 | 18 `exercises` لدليل معلم · 3 تناقضات مثبتة أرقاماً |
| `educationalPurpose` | 3 | **10%** | 0.30 | قيمتان، ارتباط تام بـ`pageType` ⇒ معلومة حافية صفر |
| الحقول المنظّمة الخاصة بالدليل | 2 | **0%** | 0.00 | `activities`/`exercises`/`vocabulary`/`answerKeyLocation`/`lessonRange` = 0/28 |

**النسبة = 20.00 + 14.40 + 10.00 + 7.00 + 4.00 + 4.00 + 3.20 + 0 + 1.50 + 0.30 + 0 = 64.40 → 64%**

> تفصيل إضافي: **طبقة النص وحدها (35 وزناً) = 95%**، بينما **طبقة الدلالة والحقول المنظّمة (45 وزناً) = 28%**. الانفصال واضح: الكتاب **مستخرَج** بإتقان و**مفهرس دلالياً** بإهمال.

### 10.2 الحكم النهائي

**الكتاب سليم كنص، وضعيف كدليل معلم مفهرس.** الاستخراج مثالي بلا فاقد حرف واحد (45,681/45,681، تغطية 1.000، صفر سطر مفقود، لا اقتطاع، لا OCR مطلوب، و`printedPage` صحيح ومختبَر و navigable). لكن الفهرس **لا يميّز دليل المعلم عن كتاب الطالب**: `pageType: exercises` على 18 صفحة من 28 تشمل 13 من 14 خطة درس، و`educationalPurpose` قالب من قيمتين ارتباطهما التام بـ`pageType` (معلومة حافية صفر)، و`section` ناقصة على 11 صفحة — **منها ص10/12/14 التي يطبع أرقام أقسامها بنفسها** — فسؤال المعلم الأهم «ما أهداف القسم 5؟» يُرجع الصفحة الصحيحة **خامساً بدرجة ميتافة مع أربع صفحات خاطئة**، وسؤال عربي عن «الوحدة الأولى» أو عن صفحة كتاب الطالب المقابلة **يُرجع صفر نتيجة** من هذا الكتاب رغم أن المعلومة موجودة حرفاً في `fullText` وتُسترجَع فوراً لو سُئلت بالإنجليزية.和信息 **المنظّمة الخاصة بالدليل — `unit`/`work`/`author`/`sectionPath`/`activities`/`answerKeyLocation`/`vocabulary`/`lessonRange` — كلها 0/28** لأن `enrichment/<bookId>.json` غير موجود، وهو ما جعل `lib/index.mjs`'s `STRUCTURED_KEYS` معطّلاً لهذا الكتاب. **الأصل الوحيد الذي يعرض الدليل كما هو فعلاً هو `outlines/<bookId>.md` (50,843 حرفاً)**؛ الفجوة إذن بين طبقة ممتازة وطبقة قائمة، لا في المصدر.

**أولوية الإصلاح:** ملف `enrichment` واحد (`G1`+`G3`) يرفع `unit/work/author/section/sectionPath/activities/answerKeyLocation/vocabulary/lessonRange` من 0 إلى 28/28 ويصلح استرجاع المعلم؛ بعده `G2` (حرفيّة `section` + `sectionPath`) يفكّ تعادل النتائج؛ ثم `G8` (حذف `.indb`) ينظّف فهرس البحث؛ ثم `G5`/`G6`/`G7` corrective للوسم الدلالي.

### 10.3 ما تم التحقق منه وما لم يمكن

**مُتحقَّق منه آلياً ومقيساً:** مطابقة النص (45,681 حرفاً) · التغطية والأسطر المفقودة · الاقتطاع (42 حرفاً/صفحة) · `.indb` والتواريخ · `printedPage` (28/28 + `locate` حيّ) · `searchable`/`ocr` · غياب الصور (0/28) · كل قيم `title`/`summary`/`section`/`pageType`/`educationalPurpose` للـ28 صفحة · تعارض العنوان بين الطبقتين (15/28) · كشف تجزئة الـ id (SHA-256 لاسم الملف) · حالات الطبقات الأربع · **ستة استعلامات بحث حيّة** عبر `lib/index.mjs` (منها إثبات ترتيب الصفحة الصحيحة خامساً والتعادل 43.7 و«صفر نتيجة» في استعلامين عربيين).

**غير متحقق منه:** جودة تلخيص الـ outline آلياً (فُحصت عيّنة: خريطة الوحدات، الـ7 مبادئ، `AYLI Section 4`؛ ولم تُدقَّق الـ28 وصفاً وصفاً) · أثر الفهرس على ranking في الواجهة الأمامية (فُحص `lib/index.mjs` فقط) · صحّة الاستعلامات الـ28 في production خلف HTTP.