# Search-index audit — `english-literature-sixth-pdf` (29 physical pages)

Consolidated from three independent visual audits (physical 1–9, 10–18, 19–29), each comparing rendered
PDF page images against the index record. All numeric claims below were re-verified directly against
`curriculum-library/search-index.json` and `curriculum-library/pdf-books/english-literature-sixth-pdf.json`.

---

## Verdict

**No — the search index is not self-sufficient for this book.** The extractor is healthy: `fullText`
(`search-index.json` → `documents[].text`) captures 100% of the printed words on all 29 pages (2,342 docs
total; 29 for this book; only one genuine gap, `New Penguin Shakespeare` on p17), and `printedPage` is
correct on all 29 (physical→printed offset is a clean **+96** throughout, 98–125). The failure is entirely
in the layers built *on top* of that text. **46.0% of the book's page text (27,444 of 59,597 chars) is
invisible** because the headline `preview` field is hard-capped at 1,200 chars, and that invisible half is
systematically the second half of every page — every one of the 13 glossaries (102 vocabulary entries),
every second Shakespeare Original/Modern-English panel, and the resolutions of nearly every story. The
index also carries **no representation of any of the 18 colour illustrations**, and those illustrations are
the direct object of 12 printed questions, so the AI cannot answer a single one of the book's own
"look at the picture" prompts. Roughly a third of pages additionally carry Arabic extractor meta-text
(`لا عنوان منفصل (تكملة النص القصصي الخاص بـ Section 3)`) as their user-facing title, and `unit` is empty
on 27/29 pages, so *"which play is this from?"* is unanswerable for the entire *As You Like It* half. The
book is a **textbook**: its teaching value lives in the vocabulary glossaries and the pictures, and those
are precisely the two things the index drops. Answering well currently depends on `fullPage()`
(`lib/index.mjs:340-349`) reaching out to `pdf-books/*.json` at request time — that is, on a second file
outside the index, not on the index being complete.

---

## Issue codes

Counts are summed across all three audit runs. Codes are normalised into a single vocabulary where the
runs used different names (e.g. `GLOSSARY_INVISIBLE` / `GLOSSARY_UNINDEXED` → `GLOSSARY_INVISIBLE`;
`SECTION_EMPTY` / `SECTION_FIELD_EMPTY` → `SECTION_MISSING`).

| Code | Count | What it means | Root cause in code |
|---|---|---|---|
| `PREVIEW_TRUNCATED` | **22** | Page text past the 1,200-char cap is not visible in the search result, the source card, or any summary. Affects p2,3,5,7–17,19–21,23,25–29. | `scripts/build-index.mjs:108` `const preview = compact(fullText, 1_200);` — the cap is the *only* text field the index surfaces (`scripts/build-index.mjs:134`). `compact()` is a hard `.slice()` (`lib/text.mjs:114-116`), so the cut lands mid-word with no truncation marker. |
| `GLOSSARY_INVISIBLE` | **13** | A "Glossary" block exists in `text` but falls past the preview cut; none of its 102 entries appear in `title`, `summary`, `keywords`, or `preview`. | Same 1,200-char cap. The extractor puts the glossary **last** on the page, and `build-index.mjs:47-51` (`pageSummary`) takes only the **first 2 sentences** of the body, so a trailing glossary can never reach the summary. No `glossary` field is ever emitted. |
| `VISUAL_UNDOCUMENTED` | **17** | 18 colour illustrations on 17 pages are described in no field of any kind. | No figure/vision field is produced anywhere in `scripts/build-index.mjs:123-142` — the doc literal has 19 keys, none visual. `needsOcr` (`:140`) only flags *missing* text, never a present-but-unread image. |
| `UNIT_MISSING` | **27** | `unit` is `""` on 27/29 pages; *"As You Like It"* appears in no field on p18–p29. | `scripts/build-index.mjs:130` copies `page.unit` straight from the PDF extraction, which never populated it. The outline **does** know the unit (`.parts` / `outlines/english-literature-sixth-pdf.md` header: "الوحدة 2 — As You Like It") but `build-index.mjs:99-107` only reads `outlinePage.title` and `outlinePage.description` — never `outlinePage.type` or the header's unit map. |
| `SECTION_MISSING` | **11** | `section` is `""` although the label is printed on the page (p5,7,9,11,13,15,17,18,20,22,24). | `scripts/build-index.mjs:129` `section: cleanText(page.section || '')` — pure pass-through of the extractor field, with no fallback to the outline `type` or to the printed heading that `pageTitle` already found. p026/p028 keep theirs, proving it's an extraction bug, not a design choice. |
| `SUMMARY_INCOMPLETE` | **12** | `summary` covers only the opening third/fourth of the page; glossaries, second panels and resolutions are never mentioned. | `scripts/build-index.mjs:47-51`: sentences are filtered to `length > 24` and then `.slice(0, 2)` — a hard **2-sentence** summary regardless of page length, taken from the *start* of the text. |
| `ACTIVITY_LINK_MISSING` | **16** | Activity numbers exist only as bare digits inside prose; there is no `activity` field, and 12 of the page's own instructions are truncated away. | No `activities` array is built in `scripts/build-index.mjs:123-142`; `pageType` (`:131`) is a single flat string, so "Activity 2 → Exercises A–E on pages 188–189 in the Activity Book" cannot be represented or filtered on. |
| `META_MACHINE_GENERATED` / `GENERIC_METADATA` | **29** | `educationalPurpose` is one of 3 canned strings keyed only to `pageType`; `reviewNotes` is the literal `"وصف مولّد من نص الصفحة"`; `reviewed: true` on all 29. | `scripts/build-index.mjs:132` `purpose: cleanText(page.educationalPurpose || '')` copies boilerplate verbatim, and `scripts/build-index.mjs:44` accepts any `page.summary` ≥ 40 chars that isn't slug-like — it never checks whether the string is generic. |
| `TEXT_INACCURATE_SUMMARY` (incl. `SUMMARY_FALSE_CLAIM` / `SUMMARY_WRONG_FOCUS` / `SUMMARY_IMPRECISE` / `SUMMARY_MISLEADING`) | **5** | Summary states something the page does not say: p6 "dismiss the party", p16 "three headings … with the texts" (only text 1 is there), p27 misplaces who led Orlando to the cave, p29 implies the play ends at the wedding, p10 "exercises to complete" hides the Activity Book range. | Same 2-sentence slice (`scripts/build-index.mjs:47-51`) with no verification pass. `reviewed: true` is set in `pdf-books` but `scripts/build-index.mjs` never consults `reviewed`/`reviewNotes` before trusting the text. |
| `TITLE_ARABIC_PLACEHOLDER` | **9** | p3,5,7,9,11,13,15,17,21 — the search headline is an Arabic extractor meta-string such as `لا عنوان منفصل (تكملة النص القصصي الخاص بـ Section 3)`, not book content. | Data: the `- **العنوان الرسمي**:` field in `curriculum-library/outlines/english-literature-sixth-pdf.md` literally contains `لا عنوان جديد (...)` / `لا عنوان منفصل (...)`. Code: `lib/outline.mjs:69` reads that field as `title`; `scripts/build-index.mjs:31` accepts it because the guard at `scripts/build-index.mjs:25-27` `usefulOutlineValue` only rejects `غير واضح|لا يوجد عنوان|لا نص مستخرج|تحتاج قراءة بصرية` — it **does not match `لا عنوان`**, the exact phrasing used. |
| `TITLE_UNINFORMATIVE` / `THIN_TITLE` | **10** | p4,6,8,10,12,14,18,20,22,24 — title is the bare slug `Section 3`, carrying no work title, so a query for "Pride and Prejudice" or "As You Like It" cannot match by title. | `scripts/build-index.mjs:31` returns `outlineTitle` verbatim (`.slice(0, 140)`) and stops. There is no composition of `unit + section + work`, and since `unit` is empty (`:130`) the record has no work name at all. Ranking boost `exactTitleMatch` (`lib/index.mjs:307`) therefore can never fire for these pages. |
| `ACTBOOK_REF_MISSING` | **6** | p10,12,14,20,26,28 — "Exercises A to E on pages NNN–NNN in the Activity Book" survives in `text` but is cut from `preview`; on p26/p28 the AI never learns Activity 2 exists at all. | 1,200-char cap again (`scripts/build-index.mjs:108`). No structured `crossReferences` field exists, so this cross-book link is retrievable only if the raw tail happens to survive truncation. |
| `SOURCEPAGE_TITLE_INVENTED_LABEL` | **8** | p20,22,24,26,28,29 (+ p5,19) — `pdf-books.title` asserts labels not on the page, e.g. `"Reading Preview: The Story So Far Before Act 2"` when the page prints `Section 2`, or `"…Before Act 3"`, `"…Before Act 4"`. | Written by the outline generator into `pdf-books`, then accepted unconditionally at `scripts/build-index.mjs:30-31` (it only checks length > 3 and slug-like content). `lib/index.mjs:371` also prefers `page.title` over the index title, so the invented label is what reaches the user. |
| `KEYWORD_NOISE` | **29** | `keywords` is dominated by English stopwords and indexes the page number: p24 → `["to","and","phoebe","the","silvius","story","with","120","his","so","is","touchstone"]`. | `scripts/build-index.mjs:138` `keywords: topKeywords(...)`; `lib/text.mjs:99-106` ranks by raw frequency over `tokens()`, and the `STOP` set at `lib/text.mjs:18-27` is **entirely Arabic** (60 entries: في، من، إلى …). No English stopword and no digit filter exists, so `the/and/of/to` always win and `"120"` is kept. No glossary headword ever reaches a keyword list. |
| `PAGETYPE_MISMATCH` | **3** | p1 divider typed `lesson_content`; p16 matching exercise typed `lesson_content`; p23 parallel-text reading page typed `exercises`; p29 final scene typed `contents` with purpose `"تحديد موضوعات الكتاب ومواقعها"`. | `scripts/build-index.mjs:131` `pageType: cleanText(page.pageType || '')` is pass-through with no validation, and the value is used in `scripts/build-index.mjs:44` to select boilerplate purpose text — so a wrong `pageType` also imports a wrong `educationalPurpose`. |
| `DANGLING_GLOSS_REF` | **4** | p14 `inn*`, p16 `playwright*`/`sonnets*`, p18 `passing*`/`pursue*`/`obey*`/`swearing*`/`grabs*`, p24 `confesses*` — asterisked headwords with no definition on the page and **no field linking to the page that defines them**. | Nothing in `scripts/build-index.mjs` extracts `*`-marked vocabulary or the "Glossary" heading, so no `glossaryRefs[]` / `glossaryDefinedHere[]` pair is ever emitted. The link exists only implicitly in `neighbors` (`pdf-books`), which `lib/index.mjs:344` loads but `lib/index.mjs:430-442` does not surface in the source card. |
| `PRESS_SLUG_NOISE` | **29** | Every page's `text` ends with the duplicated press slug `IRAQ_G12_SB_2024.indb 9X … 31/07/2025 11:28` (76 chars/page, **2,204 chars = 3.7% of the book's text**). On p1 it is 55% of the record and inflates `termsCount`. | `scripts/build-index.mjs:33,37,44,50` filter slugs from `title`/`summary` with `/indb|iraq_g12/i` and the timestamp pattern, but `usableText()` at `scripts/build-index.mjs:15-18` applies **no slug filter at all**, so the raw slug survives into `text`, `preview`, `normalized` and the term postings. |
| `LENGTH_DRIFT` | **28** | `fullTextLength` under-reports the real string on 28/29 pages (p011 declares 3,834, actual 3,834+84). | Set upstream when `pdf-books` is written, before the duplicate press slug is appended; `scripts/build-index.mjs` copies neither field and never validates, so nothing detects the mismatch. |
| `NORMALIZED_TRUNCATED` | **all 29 exceed 4,000** | `normalized` is hard-sliced to 4,000 chars — the search-normalisation form of every page on this book is incomplete, silently cutting mid-word. | `scripts/build-index.mjs:136` `normalized: normalized.slice(0, 4_000)`. `normalized` is the string used for phrase containment checks; the real damage is that anyone treating `normalized` as a faithful normalised copy of `text` is wrong on 28/29 pages here (max 3,937 + slug, so the cap bites on the longest pages and on the slug itself). |
| `TEXT_MISSING` | **1** | p17: the words **`New Penguin Shakespeare`** are visible on the Penguin cover in the image and absent from `text` entirely. | The only true extraction defect in the book — image text inside a figure, never in the PDF text layer. `scripts/build-index.mjs:140` sets `needsOcr` from `page.needsOcr` only, and this page has extractable text, so it is never flagged. |
| `PRINTED_PAGE_MISMATCH` | **0** | — | `printedPageFor` (`scripts/build-index.mjs:61-72`) is correct-by-data for this book (the extractor supplies `printedPage`), and `lib/index.mjs:269-272` resolves printed→physical directly. The one clean dimension of the audit. |

---

## Per-page verdict table

`chars lost` = `text.length − preview.length` (measured). `text present?` = whether `documents[].text` holds the
page's printed words. Physical→printed offset is **+96** for every page.

| physical | printed | issues | chars lost from preview | text present in index? | key blind spot |
|---:|---:|---|---:|---|---|
| 1 | — | PRINT_SLUG_NOISE, GENERATED_TITLE, PAGETYPE_MISMATCH, VISUAL_UNDOCUMENTED | 0 | yes (139 ch, 76 = slug) | Divider page typed `lesson_content`; slug is 55% of the record; the `97` inside the slug is not a page number |
| 2 | 98 | PREVIEW_TRUNCATED, TITLE_META_LEAK, VISUAL_UNDOCUMENTED | 730 | yes (1,930) | Origin story of the title lost: *First Impressions*, *Cecelia*, Fanny Burney, £150/£110; uncaptioned Jane Austen portrait unseen |
| 3 | 99 | TITLE_PLACEHOLDER, UNIT_MISSING, PREVIEW_TRUNCATED, GLOSSARY_INVISIBLE, VISUAL_UNDOCUMENTED | 151 | yes (1,351) | Arabic placeholder is the headline; last 2 of 4 glossary defs (`delightful`, `chaotic`) cut; P&P binding photo unseen |
| 4 | 100 | THIN_TITLE, UNIT_MISSING, VISUAL_UNDOCUMENTED | 0 | yes (835) | "Why would the Bennets be talking about the new arrival?" — answer is only in the cartoon |
| 5 | 101 | TITLE_PLACEHOLDER, SECTION_MISSING, PREVIEW_TRUNCATED, GLOSSARY_INVISIBLE, SUMMARY_INCOMPLETE | 2,033 | yes (3,233) | **62% lost**; all 6 glossary entries and Mr Bennet's defence of Lizzy invisible |
| 6 | 102 | THIN_TITLE, UNIT_MISSING, SUMMARY_WRONG_FOCUS, VISUAL_UNDOCUMENTED | 0 | yes (1,141) | Summary claims Elizabeth hears Darcy "dismiss the party" — not on the page; picture unseen |
| 7 | 103 | TITLE_PLACEHOLDER, SECTION_MISSING, PREVIEW_TRUNCATED, GLOSSARY_INVISIBLE, SUMMARY_INCOMPLETE | 2,548 | yes (3,747) | **67% lost**; all 11 glossary entries and Mrs Bennet's whole report invisible |
| 8 | 104 | PREVIEW_TRUNCATED, THIN_TITLE, UNIT_MISSING, VISUAL_UNDOCUMENTED | 205 | yes (1,405) | "What do you think about the Bingley sisters?" unanswerable; caption + Activity 2 cut |
| 9 | 105 | TITLE_PLACEHOLDER, SECTION_MISSING, PREVIEW_TRUNCATED, GLOSSARY_INVISIBLE, SUMMARY_INCOMPLETE | 2,013 | yes (3,213) | **62% lost**; all 9 glossary entries and Mrs Hurst's closing line invisible |
| 10 | 106 | PREVIEW_TRUNCATED, TITLE_UNINFORMATIVE, VISUAL_UNDOCUMENTED, ACTBOOK_REF_MISSING, META_MACHINE_GENERATED, LENGTH_DRIFT | 110 | yes (1,310) | "Why do you think Elizabeth looks so shocked?" unanswerable; Activity Book range cut mid-number at `174–1` |
| 11 | 107 | TITLE_ARABIC_PLACEHOLDER, SECTION_MISSING, PREVIEW_TRUNCATED, GLOSSARY_INVISIBLE | 2,634 | yes (3,834) | **69% lost**; "What does *bequest* mean?" returns nothing |
| 12 | 108 | PREVIEW_TRUNCATED, TITLE_UNINFORMATIVE, VISUAL_UNDOCUMENTED, SUMMARY_INCOMPLETE, ACTBOOK_REF_MISSING | 682 | yes (1,881) | Darcy's actual proposal (the climax) is past the cut; picture unseen |
| 13 | 109 | TITLE_ARABIC_PLACEHOLDER, SECTION_MISSING, PREVIEW_TRUNCATED, GLOSSARY_INVISIBLE, SUMMARY_INCOMPLETE | 2,737 | yes (3,937) | **Worst page in the book (69.5%)**; reconciliation half + all 5 glossary entries lost |
| 14 | 110 | PREVIEW_TRUNCATED, VISUAL_UNDOCUMENTED, DANGLING_GLOSS_REF, TITLE_UNINFORMATIVE, ACTBOOK_REF_MISSING | 1,343 | yes (2,542) | Lydia's elopement, Darcy paying Wickham, the engagement — all past the cut; `inn*` unresolvable |
| 15 | 111 | TITLE_ARABIC_PLACEHOLDER, SECTION_MISSING, PREVIEW_TRUNCATED, GLOSSARY_INVISIBLE, DANGLING_GLOSS_TARGET | 2,166 | yes (3,366) | All 8 glossary entries lost, incl. the `inn` definition that resolves p14; title asserts "نهاية الوحدة" not printed |
| 16 | 112 | PAGETYPE_MISMATCH, SUMMARY_FALSE_CLAIM, VISUAL_UNDOCUMENTED, DANGLING_GLOSS_REF, JUNK_KEYWORD | 0 | yes (869) | Summary claims 3 texts present, only 1 is; **two** images (Shakespeare portrait + woodland scene) totally undocumented; keyword `"112"` |
| 17 | 113 | TITLE_MIXED_LANG, SECTION_MISSING, PREVIEW_TRUNCATED, GLOSSARY_INVISIBLE, VISUAL_UNDOCUMENTED, **TEXT_MISSING** | 1,044 | **partial** — `New Penguin Shakespeare` absent from `text` | Only real extraction defect in the book; all 13 glossary entries lost; matching key (1→b, 2→c, 3→a) unreconstructable |
| 18 | 114 | SECTION_MISMATCH, TITLE_UNINFORMATIVE, VISUAL_UNDOCUMENTED, DANGLING_GLOSS_REF | 0 | yes (1,041) | `title: "Section 1"` but `section: ""`; nothing names *As You Like It*; third character in the picture invisible; 5 bare `*` markers |
| 19 | 115 | PREVIEW_TRUNCATED, GLOSSARY_INVISIBLE, UNIT_MISSING, SOURCEPAGE_TITLE_INCOMPLETE, KEYWORD_NOISE | 1,573 | yes (2,773) | **57% lost**; entire second Original+Modern panel and all 8 glossary entries |
| 20 | 116 | SECTION_MISSING, PREVIEW_TRUNCATED, VISUAL_UNDOCUMENTED, SOURCEPAGE_TITLE_INVENTED_LABEL | 120 | yes (1,320) | Preview stops mid-token at `on p` → Activity Book range 182–183 invisible; 5-figure cartoon undocumented |
| 21 | 117 | PREVIEW_TRUNCATED, GLOSSARY_INVISIBLE, TITLE_MACHINE_GENERATED, SUMMARY_INCOMPLETE, UNIT_MISSING | 1,336 | yes (2,536) | Entire `Act 2, Scene 4` panel (both columns) lost; title injects Arabic `و` into an English heading |
| 22 | 118 | SECTION_MISSING, VISUAL_UNDOCUMENTED, SOURCEPAGE_TITLE_INVENTED_LABEL, UNIT_MISSING | 0 | yes (993) | Cleanest text in the range, still 0 chars lost — but the picture is invisible, so "What are Rosalind and Orlando talking about?" is unanswerable |
| 23 | 119 | PAGETYPE_MISMATCH, PREVIEW_TRUNCATED, GLOSSARY_INVISIBLE, UNIT_MISSING | 827 | yes (2,027) | Typed `exercises` although it holds no exercise; second panel's Modern English + all 3 glossary entries lost |
| 24 | 120 | SECTION_MISSING, VISUAL_UNDOCUMENTED, SOURCEPAGE_TITLE_INVENTED_LABEL, KEYWORD_NOISE | 0 | yes (739) | `Section 4` printed but `section: ""`; 3 hidden onlookers in the picture invisible; `confesses*` dangling; keyword `"120"` |
| 25 | 121 | PREVIEW_TRUNCATED, GLOSSARY_INVISIBLE, SUMMARY_INCOMPLETE, UNIT_MISSING | 1,583 | yes (2,783) | **57% lost**; both columns of the second panel and all 9 glossary entries |
| 26 | 122 | PREVIEW_TRUNCATED, VISUAL_UNDOCUMENTED, ACTBOOK_REF_MISSING, UNIT_MISSING | 199 | yes (1,399) | Never sees caption `Orlando defeats the lioness.`, never learns Activity 2 exists, never sees range 188–189 |
| 27 | 123 | PREVIEW_TRUNCATED, GLOSSARY_INVISIBLE, SUMMARY_IMPRECISE, UNIT_MISSING | 1,464 | yes (2,664) | **55% lost**; whole Modern English column, the Ganymede apology scene and all 9 glossary entries |
| 28 | 124 | PREVIEW_TRUNCATED, VISUAL_UNDOCUMENTED, ACTBOOK_REF_MISSING, UNIT_MISSING | 179 | yes (1,379) | "What are the celebrations for?" — six dancing figures invisible; range 190–191 cut |
| 29 | 125 | PAGETYPE_MISMATCH (severe), PREVIEW_TRUNCATED, SUMMARY_MISLEADING, UNIT_MISSING | 1,767 | yes (2,967) | **Typed `contents`.** 59% lost, incl. the whole Jacque de Boys speech and the literal sentence **`The play ends.`** — the index implies the play ends at the wedding |

---

## The 15 most damaging concrete gaps

**1. `p029` (printed 125) is typed `contents` and 1,767 chars are cut — the book appears to end at the wedding.**
Image: the final scene of *As You Like It* — two parallel-text panels, two narrative paragraphs, and the
closing line **`The play ends.`**
Index: `pageType: "contents"`, `purpose: "تحديد موضوعات الكتاب ومواقعها"`, `summary` ending at
*"as celebrations begin"*, `preview` stopping at *"…The happy coup"*.
Consequence: *"How does the play end?"* / *"What happens to Duke Frederick?"* — the AI cannot say that
Jacque de Boys announces Frederick's conversion to the Crown and abdicates, or that Orlando becomes heir.
It will confidently say the play ends with four marriages.

**2. All 102 glossary definitions across 13 pages are invisible to the AI.**
Image: a "Glossary" block at the foot of p3, p5, p7, p9, p11, p13, p15, p17, p19, p21, p23, p25, p27 —
e.g. p5's `nonsense (n): something silly, crazy`, p7's `conceited (adj): with a very high opinion of
oneself`, p27's `cave (n): a large hole under the ground or in the side of a hill`.
Index: the 1,200-char `preview` cut (`scripts/build-index.mjs:108`) lands *before* the glossary on 12 of
the 13 pages; on p3 only the last 2 of 4 survive. The `*` headword markers remain searchable
(`godfather*`, `overlooked*`, `disapproval*`, `Globe Theatre*`) with no definition anywhere in the record.
Consequence: **every vocabulary question fails** — the single most likely question type for a language
textbook. "What does *bequest* mean?" returns a page with the marker and no answer.

**3. p013 (printed 109) — 2,737 of 3,937 chars lost (69.5%), the worst page in the book.**
Image: Darcy's letter read aloud and Elizabeth's reply ending the argument — *"I cannot think of it without
hating myself."* / *"We will not argue for the biggest share of blame about that evening… we have both,
I hope, improved."*
Index: `preview` ends mid-word at *"…You have taken away the best years of his life of that indepen"*.
Consequence: *"How does the argument end? Does Elizabeth forgive him?"* — the AI sees only Darcy's
indignation and Elizabeth's first accusation, and will answer that she stays angry.

**4. p007 (printed 103) — 2,548 of 3,747 chars lost (67%).**
Image: the second half of the ball scene, then the Bennets' return home and Mrs Bennet's gloating report —
*"he actually danced with her twice! and she was the only creature in the room that he asked a second
time"*, *"So proud and so conceited\* that no one could stand him! … I quite hate the man."*
Index: `preview` ends at *"…give attention to young ladies who are ignored by other men. You"*.
Consequence: *"How does Mrs Bennet describe Mr Darcy?"* — the AI never sees the report at all; the page
looks like it ends at Darcy's snub.

**5. p017 (printed 113) — the only genuine text-extraction loss in the book.**
Image: a Penguin Classics cover of *As You Like It* with `New Penguin Shakespeare` printed above the title.
Index: `text` contains neither "New Penguin" nor "Penguin" (verified) — the words were dropped by the
extractor because they live inside a figure. Nothing flags it: `needsOcr` is `false` because the page has
*other* extractable text.
Consequence: *"What edition of the play is shown?"* — unanswerable, and the AI has no signal that it
should be uncertain.

**6. 18 colour illustrations on 17 pages are described in no field whatsoever — including 12 printed questions whose only answer is the picture.**
Image examples: p4 the Bennets arguing across a lit fireplace; p6 Elizabeth worried, two Regency men
laughing behind her; p8 the Bingley sisters seated at a tea table while Darcy stands apart, hand at chin;
p10 Elizabeth facing Mr Wickham in a blue military uniform; p12 Darcy proposing, Elizabeth seated on a
purple tufted sofa with both palms raised; p16 the engraved Shakespeare portrait and a woodland scene
with a red jester; p18 Oliver gripping Orlando by the throat with a third alarmed man behind; p20 five
figures in a forest clearing; p26 a snarling lioness in a cave over a sleeping blond man; p28 six dancing
figures at a woodland celebration.
Index: the doc literal at `scripts/build-index.mjs:123-142` has 19 keys and **no figure or vision field**;
the only visual signal is the word "picture" quoted from the prompt itself in `summary`.
Consequence: **not one of these questions is answerable** — "Why do you think Elizabeth looks so shocked?"
(p10), "What do you think is going to happen next?" (p18), "Who do you think the men are, and what is
happening?" (p26), "What are the celebrations for?" (p28). The AI must say "the image isn't described".

**7. p016 (printed 112) — `summary` makes a factually false claim and `pageType` is wrong.**
Image: "Match the headings below with the texts" with heading list `a`/`b`/`c` and **only text `1`**
(Shakespeare's biography) present.
Index: `summary` = *"An exercise asking students to match three headings … with the corresponding
descriptive texts"*; `pageType: "lesson_content"`. Texts 2 and 3 are on p113; `lessonRange` and
`lineRange` are both `null`.
Consequence: *"What are the three texts about?"* — the AI will invent the contents of texts 2 and 3, and
cannot give the matching key (`1→b`, `2→c`, `3→a`).

**8. Nine pages carry Arabic extractor meta-text as their user-facing search title.**
Image: p5, p7, p9, p11, p13, p15, p17 print **no heading at all** — they open mid-sentence or with a bare
digit `2`.
Index: `title` = `لا عنوان منفصل (تكملة النص القصصي الخاص بـ Section 3)` (p9), and p15's additionally
asserts `نهاية الوحدة` ("end of the unit") — a claim **not printed on the page and not verifiable from it**.
Root cause: `lib/outline.mjs:69` copies the outline's `- **العنوان الرسمي**:` field verbatim, and the guard
at `scripts/build-index.mjs:25-27` matches `لا يوجد عنوان` but not `لا عنوان`.
Consequence: any UI or answer that quotes the page title shows Arabic extractor commentary instead of
book content; title-based ranking and `keywords` are poisoned for a third of the book.

**9. `unit` is empty on 27/29 pages and *As You Like It* appears in no field on p18–p29.**
Image: fourteen consecutive pages of Shakespeare.
Index: `unit: ""` everywhere in that range; the string "As You Like It" is absent from all 12 packets. The
outline header *does* state "الوحدة 2 — As You Like It (فيزيائية 16–29)".
Consequence: *"Which play is this from?"* / *"What is Unit 2 about?"* — unanswerable for half the book;
an AI that retrieves p020/p026 in isolation cannot say what work they come from, and `lib/index.mjs:307`'s
`exactTitleMatch` title boost can never fire for them.

**10. The second Original/Modern-English Shakespeare panel is lost on 5 of 6 parallel-text pages.**
Image: p019, p021, p023, p025, p027 each print two two-column panels — the reader's own plain-English
translation of Shakespeare's verse beside the original, plus bracketed stage directions
(`[To Celia]`, `[To Silvius]`, `[To Phoebe]`, `[To Rosalind and Orlando]`).
Index: `preview` cuts at p019 (`…after Charles leaves, he goes over his plan…`), p021 (`…His part`),
p023 (`…Go with me t`), p025 (`…Rosalind tries to put a`), p027 (`…And cried in fainting upon Rosalind`).
Consequence: *"What does Rosalind say in modern English when she meets Orlando?"* — the translation the
book exists to provide is invisible on every one of these pages.

**11. Activity Book cross-references are truncated on 6 pages; on 2 the AI never learns the activity exists.**
Image: p26 `2 Now do Exercises A to E on pages 188–189 in the Activity Book.`; p28
`2 Now do Exercises A to E on pages 190–191 in the Activity Book.`; p20's range 182–183.
Index: `preview` for p26 ends at `…he soon discovered to be h`; p28 at `…Ganymede reminded him of his
daughter. Everyb`; p20 at `…Exercises A to E on p` — the range is cut **mid-token**. No `activities[]` or
`crossReferences[]` field exists (`scripts/build-index.mjs:123-142`).
Consequence: *"Where are the exercises for this section?"* — unanswerable for 12 of 16 activity pages, and
the AI cannot even tell that a second activity was dispatched.

**12. 11 dangling vocabulary markers with no cross-page link to their definition.**
Image: p14 `When she went back to her inn*`; p16 `playwright*`, `sonnets*`; p18 `passing*`, `pursue*`,
`obey*`, `swearing*`, `grabs*`; p24 `Silvius confesses*`.
Index: those pages carry **no Glossary**, and nothing links them to p15 (`inn`), p17 (`playwright`,
`sonnet`), p19 (`passing`, `pursue`, `obey`, `swear`, `grab`) — all verified against the source.
Consequence: *"What does the asterisk mean?"* — the AI sees an unexplained marker, and even with p15/p17/p19
in hand has no field saying the two are connected.

**13. `printedPage` is right but `section` is empty on 11 pages — including 3 where the label is printed in the body.**
Image: p020 prints a large `Section 2` heading; p022 `Section 3`; p024 `Section 4`.
Index: `section: ""` on p5,7,9,11,13,15,17,18,20,22,24 — while p026/p028 **do** store `Section 5`/`Section 6`
for the identical design. `scripts/build-index.mjs:129` is a bare pass-through with no fallback.
Consequence: filtering by section silently drops half of every lesson; an AI answering "what's in Section 2?"
finds p20 and p21 for *As You Like It* and p6/p7 for *Pride and Prejudice*, indistinguishable.

**14. Summaries stop before the page's climax on 12 pages, and are outright wrong on 4.**
Image: p12's box ends *"Mr Darcy arrives and proposes to her. … Elizabeth becomes extremely upset."*
Index: p12's `summary` ends one sentence earlier — *"…Fitzwilliam hints that Darcy separated a friend from
the wrong person."* p029's ends at *"as celebrations begin"*; p027's misplaces who led Orlando to the cave;
p006 claims Elizabeth overhears Darcy *"dismiss the party"*, which the page does not say.
Root cause: `scripts/build-index.mjs:47-51` takes **only the first 2 sentences** of the body text,
regardless of page length.
Consequence: *"What is the high point of the Section 5 extract?"* — the AI reports the setup, not the event.

**15. `educationalPurpose` and `reviewNotes` are pure boilerplate, and `reviewed: true` is a false signal.**
Image: no aim box is printed anywhere — verified: "Aim" and "objective" appear in **no** `fullText` in the
entire 29-page book.
Index: all 29 pages carry `reviewed: true` with `reviewNotes: "وصف مولّد من نص الصفحة"`
("description generated from the page text"); `educationalPurpose` is one of 3 strings keyed only to
`pageType` — which is why p29's typo'd `contents` imports `"تحديد موضوعات الكتاب ومواقعها"`.
Consequence: a field that looks like human QA approval is actually an unconditional `true`. Any confidence
signal derived from `reviewed` is wrong, and the two worst errors in the book (p29 `contents`, p23
`exercises`) are exactly the class a review would have caught.

---

## What a self-sufficient index must contain

Per page, so that no PDF read is ever required. Current doc keys are 19; this spec needs ~34.

### 1. Identity and navigation (currently: mostly absent or empty)

| Field | Type | Spec | Gap today |
|---|---|---|---|
| `id` | string | `bookId:physicalPage` | ✅ present |
| `physicalPage` | int | PDF page ordinal | ✅ present |
| `printedPage` | int \| null | The folio printed on the page; `null` on dividers | ✅ present and **correct on 29/29** |
| `pageOffset` | int | `printedPage − physicalPage` (= **+96** here) | **missing** — lets a caller convert a printed number without the book-level `printed` map |
| `bookId`, `bookTitle`, `subject` | string | Inherited from the book record | book-level only, not per doc |
| `unit` | string \| null | **Must be resolved, not copied.** `الوحدة 1 — Literature Focus: Pride and Prejudice` / `الوحدة 2 — As You Like It`; inherit from the previous page when not printed | empty on 27/29 |
| `work` | string \| null | The literary work on the page: `Pride and Prejudice` \| `As You Like It` | **missing** — this is the field that would fix the 9 `Section N` thin titles |
| `author` | string \| null | `Jane Austen` \| `William Shakespeare` | **missing** — no record names the author of the extract being read |
| `section` | string | Printed `Section 1`…`Section 6`, scoped by `work` (so `Section 2` in P&P ≠ `Section 2` in AYLI) | empty on 11 |
| `sectionPath` | string | `Literature Focus > Pride and Prejudice > Section 3` | **missing** — the disambiguated key |
| `actScene` | [int,int] \| null | `[4, 3]` for `Act 4, Scene 3` | **missing** — a *Act 4, Scene 3* query cannot match `Section 6` |

### 2. Content (currently: `text` + 1,200-char `preview` + 2-sentence `summary`)

| Field | Type | Spec | Gap today |
|---|---|---|---|
| `text` | string | **Full, verbatim, uncleaned page text — no cap.** Already correct in `build-index.mjs:135`; must be the field retrieval reads, not `preview` | ✅ present, 59,597 chars for this book |
| `textLength` | int | `text.length`, computed at build time | `fullTextLength` drifts on 28/29 |
| `normalized` | string | `normalizeAr(text)` **untruncated** (drop the 4,000 `.slice()`) | sliced at `build-index.mjs:136` |
| `blocks` | array | **The real fix.** Ordered `[{ kind, text, ... }]` where `kind` ∈ `body`, `heading`, `glossary`, `caption`, `activity_instruction`, `activity_question`, `actbook_reference`, `box`, `stage_direction`, `quote`. Each activity question becomes its own addressable block | **missing entirely** — this is what makes structured QA possible |
| `paragraphs` | [string] | `text` split on blank lines, uncapped | missing |
| `summary` | string | 3–5 sentences **spanning the whole page**, or per-block summaries, not `sentences.slice(0, 2)` | stops at the page's first 2 sentences |
| `preview` | string | **First 400 + last 400 chars with an explicit `[…N chars omitted…]` marker**, or drop the field | blind `.slice(0, 1200)` hides that more exists |
| `terms` / `termsCount` | [string] / int | Unique normalized tokens from `text` | inflated by slug |

### 3. Glossaries and vocabulary (currently: 102 entries, 0 indexed)

| Field | Type | Spec | Gap today |
|---|---|---|---|
| `glossary` | [{term, pos, definition, printedOn}] | Every `Glossary` block, parsed. `printedOn` = printed folio, so p14's `inn*` resolves to `111` without a PDF read | **missing** — 102 entries in the book, all unrepresented |
| `glossaryRefs` | [{marker, term, definedOn}] | The `*`-marked words *in the body* paired with where they're defined. p14 `inn*` → `111`; p18 `grabs*` → `115`; p16 `sonnets*` → `113` | **missing** — 4 pages carry dangling markers |
| `vocabulary` | [string] | All headwords on the page, for a "vocabulary of this unit" rollup | missing |

### 4. Figures (currently: 0 of 18 recorded)

| Field | Type | Spec | Gap today |
|---|---|---|---|
| `figures` | [{id, kind, caption, description, altText, questionIds, pageRegion}] | One entry per illustration. `kind` ∈ `photograph`, `engraving`, `cartoon`, `book_cover`, `decorative`. **`description` is mandatory** and must state who is in it and what they are doing — that is the entire answer to the 12 picture questions. p004: *"Mr Bennet slumped in an armchair and Mrs Bennet gesturing beside a lit fireplace; a mantel clock and two lit candles on the mantelpiece."* | **missing** — no figure field in the doc literal |
| `figureText` | [string] | Text rendered *inside* images, so `New Penguin Shakespeare` (p17) stops being invisible | **missing** — caused the only true extraction loss |
| `needsVision` | bool | `true` when a figure carries teaching content the text does not restate | `needsOcr` only flags missing *text* |
| `layout` | string | `single-column` \| `two-panel-original-modern` \| `boxed-recap` \| `divider`. p019/021/023/025/027 are `two-panel-original-modern` | missing — the AI can't tell an Original panel from its translation |

### 5. Activities and cross-references (currently: 16 pages, 0 structured)

| Field | Type | Spec | Gap today |
|---|---|---|---|
| `activities` | [{number, instruction, type, questions[], dispatch}] | `type` ∈ `look_at_picture`, `match`, `predict`, `exercises`. p004: `{number:1, type:'look_at_picture', questions:['Why would the Bennets be talking about the new arrival?']}` | **missing** — numbers exist only as bare digits in prose |
| `dispatch` | {target: `'Activity Book'`, printedFrom, printedTo} | `{printedFrom:188, printedTo:189}` for p26 | **missing** and cut from `preview` on 6 pages |
| `continues` | {onPrinted: 113, kind: `'match_texts'`} | p16 → p17; and `"Read the extracts on the following page"` on p20/p22 | `lessonRange`/`lineRange` are `null` on all 29 |
| `recapOf` | [int] | The pink `The story so far` box restates everything up to here — a recurring pedagogical device on 10 pages | mentioned in prose, never flagged |
| `pageType` | enum | `divider` \| `lesson_content` \| `parallel_text` \| `exercises` \| `matching` — validated, not passed through | `contents` on p29, `exercises` on p23, `lesson_content` on p16, p1 |

### 6. Machine-slab and press noise (currently: 2,204 chars, 3.7% of the book)

| Field | Type | Spec | Gap today |
|---|---|---|---|
| — | — | **Strip at extraction, not at display.** `IRAQ_G12_SB_2024.indb <n>` and `31/07/2025 11:28` must be removed from `text` before tokenisation, in `usableText()` (`scripts/build-index.mjs:15-18`) | survives into `text`, `preview`, `normalized` and the postings — 76 chars × 29 pages; on p1 it is 55% of the record and inflates `termsCount` |
| `slabRemoved` | [string] | What was stripped, for auditability | missing |
| — | — | **Never index the folio glued to the front of the body text** (`115 Act 1, Scene 1 Original Oliver:…`) — that is how `"120"` became a keyword on p24 | `keywords` includes page numbers on p16, p24 |
| — | — | **Colour bars, greyscale step wedges, CMYK/spot swatch strips and crosshair/registration marks are raster, not text.** They are in every PNG and must never reach the index; if a vision pass is added, an explicit `slabRegion` lets it skip them | in the PNGs, in no field, and would be captured by any naive vision description |
| `keywords` | [string] | Built from `title + summary + blocks` with an **English** stopword list and a `^\d+$` filter | `lib/text.mjs:18-27` `STOP` is 100% Arabic; no English stopwords, no digit filter |

### 7. Provenance and honesty (currently: false signals)

| Field | Type | Spec | Gap today |
|---|---|---|---|
| `reviewed` | bool | `false` unless a human confirmed it; `reviewNotes` must not read "generated from the page text" | `true` on 29/29 with machine notes |
| `provenance` | {textSource, figureSource, extractorVersion} | `textSource: 'pdf-text-layer'`, `figureSource: 'none'` | missing |
| `completeness` | {textComplete, figuresDescribed, textChars} | `figuresDescribed: false` on 17 pages makes the blind spot machine-visible | missing |

**Size implication.** The full `text` for this book is **59,597 chars**. Adding structured `blocks`,
`glossary` (102 entries), `glossaryRefs`, `figures` (18 with ~120-char descriptions ≈ 2,200 chars),
`activities` (16), `dispatch`, and per-page provenance adds roughly **2.0–2.3× the current per-page
payload** — call it **~130–140k chars for 29 pages, ~4.8k/page**. Across the full 2,342-page library the
index would go from **31.5 MB to roughly 100–110 MB** if kept as one JSON file, which is why the current
two-file design (`search-index.json` for search + `pdf-books/*.json` read at `lib/index.mjs:340-349`)
is actually the right shape. The fix is not to inline everything into `search-index.json`; it is to
**(a) make `text` the field `retrieveContext` reads instead of `preview`** — i.e. delete the 1,200-char
cap from the answer path (`lib/index.mjs:384-406`, `PAGE_CONTEXT_CHARS = 6_000` per page,
`lib/index.mjs:13 CONTEXT_CHARS = 36_000` per answer), and
**(b) add the structural fields to `pdf-books` pages**, which already carries `educationalPurpose`,
`lessonRange`, `lineRange`, `reviewed`, `reviewNotes` and `neighbors` but surfaces none of them
(`lib/index.mjs:366-381` returns 15 keys and drops the rest).
A 1.5 GB `int8`-quantised embedding index over the full text of all 2,342 pages (~2.5M tokens) would be
the alternative, but it does not fix a 2-sentence summary or a missing figure field.

---

## Quantitative totals

| Metric | Value |
|---|---|
| Physical pages audited | **29 / 29** (three runs: 1–9, 10–18, 19–29) |
| Printed page range | 97 (divider, unnumbered) – 125; offset **+96**, consistent throughout |
| Total chars of page text (`documents[].text`) | **59,597** |
| Total chars surfaced in `preview` | **32,153** |
| **Total chars lost to the 1,200-char cap** | **27,444 = 46.0%** |
| Pages with any truncation | **22 / 29** (7 clean: 1, 4, 6, 16, 18, 22, 24) |
| **Worst page** | **p013 (printed 109)** — 2,737 of 3,937 chars lost (**69.5%**); then p011 68.6%, p007 67.9%, p015 64.3%, p029 59.6%, p005 62.9%, p009 62.7% |
| Best (least lost) | p001/p004/p006/p016/p018/p022/p024 — 0 chars |
| Press-slug chars polluting the text | **2,204 (3.7%)** — 76 chars × 29 pages, duplicated `IRAQ_G12_SB_2024.indb` + `31/07/2025 11:28` |
| **Pages where the AI cannot answer the page's own printed question** | **12** — the "look at the picture" questions on p4, p6, p8, p10, p12, p14, p18, p20, p22, p24, p26, p28, each answered only by an undocumented image. **14** if the two page-split matching keys are counted (p2→p3 texts 1/2/3; p16→p17 texts 1/2/3, with `lessonRange`/`lineRange` `null`). |
| **Undocumented figures** | **18 illustrations on 17 pages** (p1, p2, p3, p4, p6, p8, p10, p12, p14, p16×2, p17, p18, p20, p22, p24, p26, p28) — 0 described in any field. Plus prepress art (colour bars, step wedges, crosshairs) on all 29 PNGs, correctly absent from the index. |
| Glossary entries in the book | **102** across 13 pages (p3:4, p5:6, p7:11, p9:9, p11:12, p13:5, p15:8, p17:13, p19:8, p21:5, p23:3, p25:9, p27:9) — **0** in any structured field; the whole `Glossary` block falls past the preview cut on 12 of the 13 |
| Dangling vocabulary markers | **11** on 4 pages (p14, p16, p18, p24) with no field linking to the defining page |
| Pages with an Arabic placeholder / machine title | **9** (p3, p5, p7, p9, p11, p13, p15, p17, p21) |
| Pages with a bare `Section N` title | **10** (p4, p6, p8, p10, p12, p14, p18, p20, p22, p24) |
| Pages with empty `unit` | **27 / 29** (only p1, p2 populated) |
| Pages with empty `section` despite a printed label | **11** (p5, 7, 9, 11, 13, 15, 17, 18, 20, 22, 24) |
| Pages with wrong `pageType` | **4** (p1, p16, p23, p29) |
| **Text-extraction failures (chars genuinely missing from `text`)** | **1 page** (p17, `New Penguin Shakespeare`). The extractor is otherwise clean: 28/29 pages lose nothing at the text layer — a fact all three audits independently confirmed, so the 46% loss is a **presentation-layer** bug, not an OCR bug. |
| Pages with **correct** `printedPage` | **29 / 29** |
