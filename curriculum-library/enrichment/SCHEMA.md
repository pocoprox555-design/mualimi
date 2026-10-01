# مخطط تغذية الفهرس (enrichment schema v1)

هذا الملف يعرّف الحقول التي يملؤها وكيل فحص بصري لكل صفحة، ويلحقها `scripts/build-index.mjs`
بصفحة `search-index.json` حتى يصبح الفهرس مكتفياً بذاته بلا قراءة PDF ولا `pdf-books`.

## الملف الذي ينتجه الوكيل

```json
{
  "schemaVersion": 1,
  "bookId": "english-literature-sixth-pdf",
  "pages": {
    "12": { "...": "كل الحقول أدناه" }
  }
}
```

مفتاح كل صفحة = `physicalPage` (رقم صحيح كنص).

## الحقول

### الهوية والتنقل — كلها مطلوبة
| الحقل | النوع | القاعدة |
|---|---|---|
| `unit` | string | اسم الوحدة كما هو مطبوع في الكتاب. مثل `Literature Focus` أو `الوحدة 2 — As You Like It`. **لا تخترعه**: إن لم تُطبع الوحدة على الصفحة، خذها من صفحة سابقة في نفس الكتاب (مررّر السياق). إن لم تكن هناك وحدات أصلاً فـ `null`. |
| `work` | string \| null | العمل الأدبي: `Pride and Prejudice` أو `As You Like It`. |
| `author` | string \| null | `Jane Austen` أو `William Shakespeare`. |
| `section` | string \| null | عنوان القسم المطبوع: `Section 1` … `Section 6`. انسخه حرفياً. |
| `sectionPath` | string \| null | `Literature Focus > Pride and Prejudice > Section 3` — يميّز `Section 2` في عمل عن `Section 2` في عمل آخر. |
| `actScene` | [int, int] \| null | `[4, 3]` لو الصفحة `Act 4, Scene 3`. |
| `pageType` | enum | واحد فقط من: `divider` · `lesson_content` · `parallel_text` · `boxed_recap` · `matching` · `exercises` · `glossary` · `contents`. **اختره من واقع الصورة** لا من التخمين. |
| `title` | string | عنوان يصف محتوى الصفحة، **بالعربية**، 10–90 حرفاً. **ممنوع** أن يكون: `Section 3` وحده، أو نصاً استخراجيا مثل `لا عنوان منفصل (...)`، أو اسم ملف. مثال جيد: `قسم 3: ملخص القصة وبنوك الإجابة للمشكلة`. |
| `titleEn` | string \| null | نفس العنوان بالإنكليزية إن كانت الصفحة إنكليزية بالكامل. |
| `summary` | string | **عربي**، 40–200 حرف، يغطي **كامل الصفحة** لا أولها: Emerson.المحتوى + المفردات + الرسوم + التمارين + ما ي следующий. |
| `summaryEn` | string \| null | نفس الملخص بالإنكليزية للصفحات الإنجليزية. |

### المفردات
| الحقل | النوع | القاعدة |
|---|---|---|
| `glossary` | array | كل مدخل من كتلة **Glossary** المطبوعة: `{ "term": "bequest", "pos": "n", "definition": "money or property given at the request of a dying one" }`. انسخ التعريف حرفياً بالإنكليزية. **لا تخترع تعريفاً لم ي.print**. |
| `glossaryRefs` | array | الكلمات المعلَّمة بنجمة `*` داخل النص والمعرَّفة في صفحة أخرى: `{ "marker": "inn*", "term": "inn", "definedOnPrintedPage": 111 }`. |
| `vocabulary` | [string] | كل الكلمات المطلوب تعريفها في الصفحة (من Glossary + من النجوم). |

### الرسوم
| الحقل | النوع | القاعدة |
|---|---|---|
| `figures` | array | **رسمة واحدة لكل عنصر**، وحقلك `description` هو الجواب الوحيد عن سؤال «انظر إلى الصورة». |
| `figures[].id` | string | `p12-fig1` |
| `figures[].kind` | enum | `photograph` · `engraving` · `cartoon` · `book_cover` · `decorative` · `map` · `chart` |
| `figures[].caption` | string \| null | النص المطبوع أسفل الصورة حرفياً، أو `null` إن لم يوجد. |
| `figures[].description` | string | **إجباري، 30–150 كلمة، عربي.** يجب أن يجيب: من الشخص/الأشخاص الظاهر، ماذا يفعل، أين، وما لون/تفصيل يميّز المشهد. مثال: «ليزابيث بشعرها Blond مصفوف ذيل حصان بفستان أخضر فاتح وقفازات بيضاء طويلة، تقف حائرة أمام السيد ويكهام بزيّ عسكري أزرق بزر ذهبية وحواف ذهبية؛ الجدران وردية وفيها لوحة مؤطرة لجسر أحمر، وبجانبها باب خشبي.» **لا تكتب «صورة لنص» أو «رسم توضيحي» — هذه فاشلة.** |
| `figures[].figureText` | [string] | أي نص **مطبوع داخل الصورة** ولا يوجد في نص الصفحة المستخرج (مثل `New Penguin Shakespeare` على غلاف بنغوين). |
| `figures[].questionIds` | [string] | معرّفات أسئلة التمارين التي تعتمد على هذه الرسمة. |

### الأنشطة والتمارين
| الحقل | النوع | القاعدة |
|---|---|---|
| `activities` | array | كل نشاط مطبوع رقّماً. |
| `activities[].number` | int | الرقم المطبوع بجوار النشاط. |
| `activities[].type` | enum | `look_at_picture` · `match` · `predict` · `exercises` · `order` · `fill_gaps` · `true_false` · `multiple_choice` · `write` · `discuss` |
| `activities[].instruction` | string | نص التعليمات **حرفياً** (بأخطائه)، فارغ `""` إن لم يوجد. |
| `activities[].questions` | [string] | كل سؤال/بند مطبوع، **نصه كاملاً**. |
| `activities[].figureIds` | [string] | الرسومات التي يعتمد عليها. |
| `activities[].answerFormat` | string | **مهم جداً:** `checkboxes` · `one_line_each` · `ruled_lines_8` · `gap_fill` · `numbered_blanks` · `two_column_match` · `checkboxes_8` … اكتب ما هو مطبوع فعلاً. |
| `exercises` | array | إذا كانت الصفحة تمارين: `{ "letter": "A", "instruction": "Are these sentences true (T) or false (F)?", "items": [ { "n": 1, "kind": "tf", "stem": "…", "answer": null } ], "answerLines": 1 }`. **لا تضع الإجابة** إلا إن كانت مطبوعة في الكتاب. `kind` ∈ `tf` · `mc` · `gap` · `order` · `match` · `short_answer` · `composition`. |
| `answerKeyLocation` | string \| null | أين الإجابات: مثل `في كتاب الطالب صفحة 101` أو `دليل المعلم`. |

### العلاقات
| الحقل | النوع | القاعدة |
|---|---|---|
| `continuesOn` | object \| null | `{ "printedPage": 113, "kind": "match_texts" }` — الصفحة تبدأ نشاطاً يكمل في صفحة أخرى. `kind` ∈ `match_texts` · `glossary_split` · `exercises_split` · `continued` |
| `recapOf` | [int] | أرقام الصفحات **المطبوعة** التي يلخّصها صندوق «The story so far» الموجود في الصفحة. |
| `notes` | string \| null | ملاحظة قصيرة إن كان في الصفحة شيء غامض أو تعذّرت قراءته. |

## قواعد إلزامية

1. **لا تخترع.** كل قيمة إما منسوخة حرفياً من الصورة أو `null`. الغموض يُكتب في `notes` لا في الحقول.
2. **الأرقام فاطحة.** لا تعدّ من الذاكرة — عدّ من الصورة. «خمسة أسئلة» يجب أن تكون `questions` فيها 5 عناصر فعلاً.
3. **الشرطات والفراغات جزء من السؤال.** اكتب `f______` كما هي، لا `f`.
4. **العربية أولاً.** `title` و `summary` بالعربية، و `titleEn`/`summaryEn` بالإنكليزية للصفحات الإنجليزية. الأسماء والمصطلحات الإنجليزية تبقى إنكليزية.
5. **لا تكتب نصوصاً استخراجية** في أي حقل. ممنوع: `لا عنوان` · `لا يوجد` · `يحتاج قراءة بصرية` · `وصف مولّد` · `صفحة مصورة`.
6. **الرسوم الزخرفية** (أشرطة الألوان، علامات التسجيل، إطار الصفحة) لا تُوصف — لست `figures`. لكن اذكر في `notes` إن كان هناك رسمة ذات دلالة تعليمية لا تستطيع وصفها.
