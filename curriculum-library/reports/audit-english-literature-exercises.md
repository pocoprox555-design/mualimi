# Consolidated audit — `english-literature-exercises-sixth-pdf` (24 pages, printed 168–191)

Sources consolidated: two sub-agent visual audits (physical 1–12, physical 13–24).
Every code citation and every quantitative claim below was **re-verified by the consolidator** against
`curriculum-library/search-index.json`, `curriculum-library/pdf-books/english-literature-exercises-sixth-pdf.json`,
`curriculum-library/pdf-index.json`, `curriculum-library/outlines/*.md`, `scripts/build-index.mjs`,
`lib/index.mjs`, `lib/text.mjs`, `lib/outline.mjs`. Disputed sub-agent findings are recorded in
§2.1 rather than silently dropped.

---

## Verdict

**No — the index is not self-sufficient for this exercises book.** All 24 pages are text-searchable and the
full page text is faithfully extracted (0 words lost, `documents[].text` matches `pdf-books.fullText` on 24/24
pages), so an AI can quote the instructions and every item. But the exercise *mechanism* is absent from
**every field of the index on 24/24 pages**: `fullText` contains **0 checkbox glyphs and 0 underscore runs**,
so `= f______` is stored as `= f`, `Elizabeth ______ Mr Darcy` as `Elizabeth Mr Darcy of being cruel.`, and
`4 ____________ for Lady Catherine` as `4 for Lady Catherine` — an AI cannot tell a letter-scaffold from a
finished answer, and will state gap-fill answers as if they were given. Beyond that, 6 exercise pages are typed
`lesson_content` with a "read definitions" purpose, 12 pages have an empty `section`, 3 pages carry a
factually false title or summary, 52.8% of all keyword slots are English stopwords, and no page anywhere
declares that this 24-page volume contains **no answer key at all**. The one systemic bright spot is the
serving path: `retrieveContext()` re-reads the full page text via `fullPage()`, so the 1,200-char `preview`
truncation both sub-agents called the top defect does **not** actually reach the model.

---

## Issue codes

| Code | Count | Meaning | Root cause (file:line, verified) |
|---|---|---|---|
| `ANSWER_STRUCTURE_ABSENT` | **24/24** | No checkboxes, no answer rules, no gap-fill underscores anywhere in the index. Measured: 0 `□`/`☐` glyphs and 0 `_{2,}` runs across all 24 pages of `fullText`. Nothing in `title`/`summary`/`preview`/`text`/`keywords`/`outlineSummary` records that the student must tick a box or write on a line. | **Upstream of the index builder.** The text is already flattened inside `curriculum-library/pdf-books/*.json → pages[].fullText`, so `scripts/build-index.mjs:15-18` (`usableText()`) receives it destroyed. `build-index.mjs:123-142` emits no `answerMechanism`/`itemStructure` field, and `lib/index.mjs:219-237` (`resultFor`) has no slot to return one. |
| `VISUAL_UNDOCUMENTED` | **24/24** | Banner (`L` tab + *Pride and Prejudice* / *As You Like It* plate), CMYK calibration bars, 3 registration crosshairs, crop marks, alternating tab position — none described in any index field. The bare token `L` appears in `text` as an unexplained word (`p001`: `168 L Literature Focus Section 1`). | Same as above: no visual/layout field is ever produced. `build-index.mjs:123-142`. |
| `ENGLISH_STOPWORD_KEYWORDS` | **24/24** | 152 of 288 keyword slots (52.8%) are English function words. `the` is a keyword on all 24 pages; `and`, `to`, `of`, `in`, `you`, `is`, `was` crowd out pedagogically useful terms. p021's 12 keywords are `the, oliver, and, orlando, to, you, in, from, that, frederick, about, tell`. | `lib/text.mjs:18-27` — the `STOP` set is **Arabic-only** (no `the/and/of/to/in/is/was/it/you`). Consumed by `lib/text.mjs:66-70` (`tokens`) → `lib/text.mjs:99-106` (`topKeywords`) → `scripts/build-index.mjs:138`. |
| `PRESS_SLUG_IN_TEXT` | **24/24** | 85 chars per page of `IRAQ_G12_AB_2024.indb 168 IRAQ_G12_AB_2024.indb 168 04/08/2025 10:21 04/08/2025 10:21` at the tail of every `fullText` — **2,040 chars = 8.9% of the book's 23,009**. Wasted preview budget on p009/p015/p022. | `scripts/build-index.mjs:15-18` — `usableText()` applies **no** `/indb\|iraq_g12/i` filter, even though `:33`, `:37`, `:44`, `:50` all filter the slug out of `title`/`summary`. |
| `ANSWER_KEY_UNDOCUMENTED` | **24/24** | Grep over all 24 pages: `answer key` = 0, `الإجابات` = 0, `مفتاح` = 0, `Teacher's Book` = 0. The volume ships **no key**, and no field says so. An AI asked "where are the answers?" will invent a page. | No `answerKeyAvailable` field exists (`build-index.mjs:123-142`); the fact lives only implicitly in `book.referenceKind = 'official-exercises'` (`build-index.mjs:94`). |
| `SECTION_FIELD_MISSING` | **12/24** | `section` is `""` on p009–p016, p018, p020, p022, p024. On **4** of them (p009/176, p011/178, p013/180, p015/182) the heading *is* printed and *is* inside `text` — the field simply lies. | `scripts/build-index.mjs:129` `section: cleanText(page.section \|\| '')` is a **pure pass-through** of `pdf-index.json`, which populated only 12 of 24 pages. The outline that *does* know the section is not consulted: `lib/outline.mjs:82-88` emits `{physicalPage, printedPage, type, title, description}` with **no `section` key**. |
| `TITLE_SECTION_INFERRED` | **12/24** | Continuation pages (p002, 004, 006, 008, 010, 012, 014, 016, 018, 020, 022, 024) assert `Literature Focus Section N (…)` although no section heading is printed on them. p002 `fullText` contains no "Section" string at all, yet its title reads `Literature Focus Section 1 (Pride and Prejudice) — التمارين C وD وE`. | `scripts/build-index.mjs:29-39` (`pageTitle`) returns `outlinePage.title` unconditionally at `:31`, and the outline file is hand-authored per page. |
| `PAGE_TYPE_WRONG` | **6/24** | p004, p006, p014, p018, p020, p024 are pure exercise pages (C/D/E) but typed `lesson_content`, while their exercise-only siblings p003, p005, p013, p017, p019, p021, p023 are typed `exercises`. Any `pageType` filter drops 25% of the book. | `scripts/build-index.mjs:131` `pageType: cleanText(page.pageType \|\| '')` — pure pass-through of `pdf-index.json`, with no check that the page contains exercise letters. |
| `PURPOSE_BOILERPLATE` | **6/24** | The same 6 pages carry `purpose = "قراءة التعريفات والأمثلة والمحتوى التعليمي."` ("read definitions and examples / lesson content") — the page contains **no** definitions. | `scripts/build-index.mjs:132` `purpose: cleanText(page.educationalPurpose \|\| '')` — pass-through of a value that was never per-page specific. The 18 correct pages share the other boilerplate `"تطبيق المفاهيم والتدرب على نمط الأسئلة."`. |
| `GAP_FILL_AMBIGUITY` | **9/24** | 57 gap markers flattened. Printed `a large amount of money = f______` → indexed `1 a large amount of money = f`. p002(8) p004(7) p006(5) p008(7) p010(6) p012(6) p014(6) p016(7) p020(5). The `=`-tail regex confirms the *only* surviving trace is the scaffold letter, so `= a` reads as a complete answer. | Extraction defect upstream; `build-index.mjs:15-18` has no restore step, and `build-index.mjs:108` (`preview`) further truncates on p003/p009/p015/p021/p022. |
| `GAP_ANSWER_LEAKED_INLINE` | **2/24** | Numbered gap slots lost their blank, so the **answers** survive as if they were the prompt: p016 → `4 ,` ; p022 → `the 3 .`, `been 6 .`, `7 .` (orphaned punctuation = the vanished blank). | Same extraction defect. p022's preview also cuts at 70 chars (`…IRAQ_G12_AB_202`). |
| `EXERCISE_ITEM_COUNT_MISSING` | **10/24** | No page states how many items each exercise has. Unstated: p007 A=6, p013 A=4, p017 A=5, p018 D=6, p020 D=5, p021 B=5-of-7, p023 C=4-of-5, p024 D=7, p005 A=5, p011 A=5. The count lives only in a reviewed English sentence or not at all. | `scripts/build-index.mjs:47-51` (`pageSummary`) takes `sentences.slice(0, 2)`; the reviewed-summary branch at `:43-44` never parses counts either. No `itemCount` field is emitted. |
| `KEYWORD_PRINT_ARTIFACT` | **10/24** | 9 bare page numbers become keywords: p002→`169`, p004→`171`, p006→`173`, p010→`177`, p011→`178`, p012→`179`, p014→`181`, p018→`185`, p020→`187`. Plus `iraq` (the press slug) on p006. | `lib/text.mjs:99-106` (`topKeywords`) has no numeric/latin-noise filter, and `scripts/build-index.mjs:138` feeds it `preview`, which carries the slug and the running page number. |
| `CROSSREF_UNSTRUCTURED` | **12/24** | 12 pages carry `on page NNN of the Student's Book` (101, 103, 105, 107, 109, 111, 115, 117, 119, 121, 123, 125) — present in `text`, absent from `title`, `summary` and `keywords`. An AI never learns the student must read p115 first. | `scripts/build-index.mjs:109-118` builds `searchableText` from those fields but `keywords` at `:138` uses only `title + summary + preview`; no `crossReferences` field is emitted. |
| `PREVIEW_TRUNCATED` | **5/24, 553 chars** | p003=70, p009=**259**, p015=146, p021=8, p022=70. The cut is a hard `.slice()` with no omission marker, so it lands mid-word (`…only grew after learn`). | `scripts/build-index.mjs:108` `const preview = compact(fullText, 1_200);` with `compact()` = `.slice(0, max)` at `lib/text.mjs:114-116`. **Mitigated:** `lib/index.mjs:418` calls `fullPage()` which re-reads the complete `fullText` from `pdf-books`, and `lib/index.mjs:12` sets `PAGE_CONTEXT_CHARS = 6_000` — 4× the largest page (1,459 chars) — so 100% of every page reaches the model. |
| `SUMMARY_FALSE_CLAIM` | **3/24** | p013 `summary`: "sequencing **five** events" — A has **4** (verified in `fullText`). p010 `summary`: "matching **six words** to their meanings" — only the six *meanings* are printed; the student must find the words. p008 `title`: "Writing as **Mr Darcy's Father**" — the page says "Imagine you are **the late Mr Darcy**"; p008's own `summary` contradicts its `title`. | `scripts/build-index.mjs:43-44` trusts the reviewed `page.summary` verbatim, checking only for slug patterns; `:29-31` trusts the outline title verbatim. No count cross-check against `fullText` exists anywhere. |
| `TITLE_ARABIC_INJECTED` | **1/24** | p001 `title` = `Literature Focus Section 1 (الوحدة: Pride and Prejudice) — التمارين A وB`. No `الوحدة` label exists anywhere on printed 168, and p001 is the only page using this format. | Not a pass-through: `scripts/build-index.mjs:30-31` prefers `outlinePage.title`, and the Arabic string originates in `curriculum-library/outlines/english-literature-exercises-sixth-pdf.md`, parsed at `lib/outline.mjs:69` (`field('العنوان الرسمي')`). |
| `BOX_NUMBER_ARTIFACT` | **1/24** | p024 exercise D's 7 boxes: pre-printed digits in boxes 2 and 3 are read as line numbers — `…met with an old religious man. 2 I am the second son…` and `…kill his brother. 3 I swear on my life…`. The other 5 boxes are empty and carry no marker, so the true count (7) is unrecoverable from the text. | Extraction defect; `build-index.mjs:108` preview (1,068 chars, uncapped here) reproduces it verbatim. |
| `LENGTH_FIELD_MISMATCH` | **0/24** | **Disputed — see §2.1.** `documents[].text.length === pdf-books.fullText.length` on all 24 pages. | n/a |
| `META_TEXT_LEAK` | **0 in index** | `reviewNotes: "وصف مولّد من نص الصفحة"` and `reviewed: true` exist on 24/24 `pdf-books` pages but are **not copied** into any `search-index` document. | `scripts/build-index.mjs:123-142` omits both fields. Harmless today; a hazard if the pass-through is ever widened. |
| `PAGE_NUMBER_MISMATCH` | **0/24** | `printedPage` 168–191 is correct on all 24 pages. | `scripts/build-index.mjs:100-103` |
| `WORD_LEVEL_TEXT_LOSS` | **0/24** | No visible printed word is absent from `text`. Book typos are faithfully preserved (`blame someone of something` for, p008; `Why is Mr Darcy **reddish**` p010) — correct behaviour, but the nonsense is propagated with no `[sic]`. | Extraction is faithful. |

### 2.1 Disputed sub-agent findings resolved

| Sub-agent claim | Verdict | Evidence |
|---|---|---|
| `LENGTH_FIELD_MISMATCH` on 22–23 of 24 pages (both audits) | **False — a measurement artifact.** `fullTextLength` is *not* a declared index field; `.pdfverify/make-packets.mjs:43` computes it as `String(p.fullText \|\| '').length`. Measured directly: `doc.text.length` = `pdf-books.fullText.length` on 24/24 pages (e.g. p001 = 1101 = 1101). The reported "declared" values (1101 vs "actual 1107") were the sub-agents' own manual counts. | `scripts/build-index.mjs:123-142` emits no `fullTextLength`. |
| "259 characters of exercise content are **invisible to any search-based AI**" (audit 1 gap #1) | **Overstated.** The characters are absent from `documents[].preview` only. `lib/index.mjs:418` → `fullPage()` reloads the full `fullText`; budget 6,000 ≫ 1,459. Real cost is limited to the `sources[].preview` field shown to the client and to any consumer reading `search-index.json` directly. | `lib/index.mjs:12, 351-382, 415-423`; `server.mjs:184`. |
| "T/F statement 8 (`Silvius is in love with Phoebe`) is **never** seen" (audit 2 gap #4) | **Same overstatement.** It is present in `fullText`; only `preview` cuts before it. | `pdf-books` p015 `fullText`. |
| Re-ordering exercises "indistinguishable from a straight reading" (audit 1 gap #7) | **Overstated.** The instruction survives on all 7 re-ordering pages (p005, 011, 013, 017, 019, 022, 024) — e.g. p005 `A Read the extract … and put the events in the order they happened.` What is missing is the checkbox and the item count, not the instruction. | `pdf-books` p005/p011/p013/p017/p019/p022/p024. |
| `META_TEXT_LEAK` on 12/12 pages (audit 2) | **Out of the index.** `reviewNotes`/`reviewed` never reach `search-index.json`. | `scripts/build-index.mjs:123-142`. |
| "answers are in the Student's Book / Activity Book" (both audits) | **Student's Book yes (12×), Activity Book never.** Grep: `Student's Book` = 12, `Activity Book` = 0, `answer key` = 0. | `pdf-books` all 24 pages. |
| `SECTION_FIELD_MISSING` = 4 (audit 1) / 2 (audit 2) | **Both under-counted: 12.** | Measured `section === ''` on p009–p016, p018, p020, p022, p024. |
| `PAGE_TYPE_WRONG` = 2 (audit 1) / 4 (audit 2) | **Union is 6 and correct.** | Measured `pageType === 'lesson_content'` on p004, p006, p014, p018, p020, p024. |
| `GAP_FILL_AMBIGUITY` = 6 (audit 1) | **9.** Audit 1 missed p014, p016, p020 because the printed gap is a *rule* (`a lady = ______`) with no letter, so the `= <letter>` signature does not fire. | 57 markers over 9 pages. |
| `EXERCISE_STRUCTURE_MISSING` = 4 (audit 2) | **10.** | Item counts unstated on 10 pages. |
| **New, missed by both** | `SECTION_ID_COLLISION`: P&P and *As You Like It* both use `Literature Focus Section 1..6`. p005 (`Section 3`, P&P) and p017 (`Section 3`, AYLI) carry an identical `section` value — `section` is not a safe grouping key across this book. | `pdf-books` p005 vs p017. |

---

## Per-page verdict table

`issues` uses short codes; `→` means "full field list in §Issue codes". `text complete` = `documents[].text` holds the entire `pdf-books.fullText` (true on 24/24).

| physical | printed | issues | chars lost from preview | text complete in index? | key blind spot (short) |
|---|---|---|---|---|---|
| 1 | 168 | `TITLE_ARABIC_INJECTED` `PRESS_SLUG` `STOPWORD_KW` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` `CROSSREF_UNSTRUCTURED` `EX_COUNT_MISSING` | 0 | yes | 6 T/F boxes + 7 answer lines absent; `الوحدة:` label invented; extract at Student's Book p.101 unlinked |
| 2 | 169 | `SECTION_INFERRED` `GAP_FILL`×8 `KEYWORD_ARTIFACT(169)` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` `EX_COUNT_MISSING` | 0 | yes | `= f` / `= g -u` — letter-scaffold reads as a finished answer; 22 ruled lines invisible |
| 3 | 170 | `PREVIEW_TRUNCATED`×70 `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` `EX_COUNT_MISSING` `CROSSREF_UNSTRUCTURED` | 70 | yes | 7 T/F boxes invisible; truncation is boilerplate-only (harmless in serving path) |
| 4 | 171 | `PAGE_TYPE_WRONG` `PURPOSE_BOILERPLATE` `SECTION_INFERRED` `GAP_FILL`×7 `KEYWORD_ARTIFACT(171)` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` | 0 | yes | filed as `lesson_content`; `= s` reads as answer; 20 answer lines invisible |
| 5 | 172 | `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` `EX_COUNT_MISSING` `CROSSREF_UNSTRUCTURED` | 0 | yes | 5 ordering boxes + 4 match-tick boxes invisible; A=5 never stated |
| 6 | 173 | `PAGE_TYPE_WRONG` `PURPOSE_BOILERPLATE` `SECTION_INFERRED` `GAP_FILL`×5 `KEYWORD_ARTIFACT(173,iraq)` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` | 0 | yes | `= a`/`= l`/`= u` read as answers; 13 writing lines (longest in book) invisible |
| 7 | 174 | `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` `EX_COUNT_MISSING` `CROSSREF_UNSTRUCTURED` | 0 | yes | 6 boxes + 6 lines invisible; B's free-text answer format never signalled |
| 8 | 175 | `SUMMARY_FALSE_CLAIM` `SECTION_INFERRED` `GAP_FILL`×7 `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` | 0 | yes | title says "as Mr Darcy's Father", page says "you are the late Mr Darcy"; `= r` reads as answer |
| 9 | 176 | `PREVIEW_TRUNCATED`×259 (worst) `SECTION_MISSING(heading printed)` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` `CROSSREF_UNSTRUCTURED` | **259** | yes | `section` empty although `text` literally contains "Literature Focus Section 5"; 7 boxes invisible; preview cuts mid-word at "…only grew after learn" |
| 10 | 177 | `SECTION_MISSING` `SUMMARY_FALSE_CLAIM` `GAP_FILL`×6 `KEYWORD_ARTIFACT(177)` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` | 0 | yes | summary invents "matching six words to their meanings" — only meanings are printed |
| 11 | 178 | `SECTION_MISSING(heading printed)` `KEYWORD_ARTIFACT(178)` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` `EX_COUNT_MISSING` | 0 | yes | 5 ordering boxes invisible; B items 1–2 are quote-gloss questions — the index flattens all 6 as uniform |
| 12 | 179 | `SECTION_MISSING` `SECTION_INFERRED` `GAP_FILL`×6 `KEYWORD_ARTIFACT(179)` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` | 0 | yes | printed `3 ____________ for Lady Catherine` → `3 for Lady Catherine`; position of the blank is unrecoverable |
| 13 | 180 | `SECTION_MISSING(heading printed)` `SUMMARY_FALSE_CLAIM` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` `EX_COUNT_MISSING` `CROSSREF_UNSTRUCTURED` | 0 | yes | summary says "sequencing **five** events"; A has **4** (verified in `text`) |
| 14 | 181 | `PAGE_TYPE_WRONG` `PURPOSE_BOILERPLATE` `SECTION_MISSING` `SECTION_INFERRED` `GAP_FILL`×6 `KEYWORD_ARTIFACT(181)` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` | 0 | yes | `1 will =` — six write-in slots look like completed statements; ~15 writing lines invisible |
| 15 | 182 | `PREVIEW_TRUNCATED`×146 `SECTION_MISSING(heading printed)` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` `EX_COUNT_MISSING` | 146 | yes | 8 T/F boxes invisible; `section` empty though "Literature Focus Section 2" is in `text`; preview cuts mid-word at "…Silvius thinks he is bo" |
| 16 | 183 | `SECTION_MISSING` `SECTION_INFERRED` `GAP_ANSWER_LEAK` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` | 0 | yes | `4 ,` — the answer survives, the blank does not; 7 `=` slots flattened to bare `1 a lady =` |
| 17 | 184 | `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` `EX_COUNT_MISSING` `CROSSREF_UNSTRUCTURED` | 0 | yes | A's 5 T/F items, B's 4 ordering boxes, C's 5 lines — no count, no mechanism |
| 18 | 185 | `PAGE_TYPE_WRONG` `PURPOSE_BOILERPLATE` `SECTION_MISSING` `SECTION_INFERRED` `KEYWORD_ARTIFACT(185)` `EX_COUNT_MISSING` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` | 0 | yes | D has **6** scrambled lines, summary says none; run-together `…every tree Run, run Orlando, write in books…` blurs item boundaries |
| 19 | 186 | `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` `EX_COUNT_MISSING` `CROSSREF_UNSTRUCTURED` | 0 | yes | **strongest page in the book** — summary counts are accurate; only the 4 boxes + 7 lines are missing |
| 20 | 187 | `PAGE_TYPE_WRONG` `PURPOSE_BOILERPLATE` `SECTION_MISSING` `SECTION_INFERRED` `GAP_FILL`×5 `KEYWORD_ARTIFACT(187)` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` | 0 | yes | 4×4 match grid's tick boxes invisible; `you =`/`my =` read as answers |
| 21 | 188 | `PREVIEW_TRUNCATED`×8 `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` `EX_COUNT_MISSING` `CROSSREF_UNSTRUCTURED` | 8 | yes | B is **split** across 188→189 (7 items total); only the Arabic `title` says so, `summary` says "five statements" |
| 22 | 189 | `PREVIEW_TRUNCATED`×70 `SECTION_MISSING` `GAP_ANSWER_LEAK` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` | 70 | yes | `the 3 .` / `been 6 .` — answers inline, blanks gone; 8 boxes + 6 lines invisible |
| 23 | 190 | `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` `EX_COUNT_MISSING` `CROSSREF_UNSTRUCTURED` | 0 | yes | 6×6 match grid's 6 gutter boxes invisible; C is 4-of-5, no single field says 5 |
| 24 | 191 | `PAGE_TYPE_WRONG` `PURPOSE_BOILERPLATE` `SECTION_MISSING` `SECTION_INFERRED` `BOX_NUMBER_ARTIFACT` `EX_COUNT_MISSING(D=7)` `STOPWORD_KW` `PRESS_SLUG` `VISUAL_UNDOC` `ANSWER_KEY_UNDOC` | 0 | yes | `2 I am the second son` / `3 I swear on my life` — pre-printed box digits read as line numbers; true count 7 unrecoverable |

---

## The 12 most damaging concrete gaps

1. **Every answer space is gone from every field, on all 24 pages.** Measured: **0** checkbox glyphs and **0** underscore runs in 24 pages of `fullText`. Printed `a large amount of money = f______` is stored as `1 a large amount of money = f` (p002). *Consequence:* an AI cannot distinguish a one-letter scaffold from a finished answer, will state the scaffold as the answer, and cannot tell the student how long an answer should be. No field in the schema can even express this.
2. **Printed sentence-completion blanks are deleted, producing ungrammatical prompts.** Printed p008 D1 `Elizabeth ______ Mr Darcy ______ of being cruel.` → indexed `1 Elizabeth Mr Darcy of being cruel.`; p008 D5 → `5 Mr Darcy often Elizabeth.` *Consequence:* D is literally unanswerable from the index, and an AI asked "give me the seven sentences" returns nonsense.
3. **Leading and trailing blanks are unrecoverable, not just the middle.** Printed p012 D3 `3 ____________ for Lady Catherine, Elizabeth's feelings…` → indexed `3 for Lady Catherine, Elizabeth's feelings for Mr Darcy had changed.`; p012 D6 → `6 … her relationship .` *Consequence:* the AI cannot know a word is required *before* the clause or *after* it — it will produce a fluent but wrong completion.
4. **Gap-fill answers leak into the prompt as if they were supplied.** p016 → `1 escape`, `2 between`, `3 girls`, `4 ,`, `5 a thousand`, `6 as`, `7 for`; p022 → `a 1 to find`, `the 3 .`, `Oliver 4 clothes`, `been 6 .`. *Consequence:* the model reads the answer key of the exercise and treats it as the question. This is the failure mode that produces confidently wrong homework help.
5. **p013's summary is factually wrong.** Image: exercise A orders **4** events (Charles warns Oliver; Oliver and Orlando fight; Orlando complains to a servant; Oliver plans to use Charles). Index: "sequencing **five** events". *Consequence:* "how many events must I order on printed 180?" is answered wrong with confidence, and the model may invent a fifth event.
6. **p010's summary describes a matching task the page does not contain.** Image: `D Find a word in the text that means: 1 hate … 6 the way someone speaks` — six *meanings*, no word list. Index: "a vocabulary exercise **matching six words to their meanings**". *Consequence:* the model tells the student to match a supplied word list, when the actual task is a search-the-extract hunt; the initial-letter scaffold is the only clue and is not explained.
7. **6 of 24 exercise pages are typed `lesson_content` with a false purpose.** p004, p006, p014, p018, p020, p024 carry `purpose = "قراءة التعريفات والأمثلة والمحتوى التعليمي."` *Consequence:* any consumer filtering `pageType === 'exercises'` silently loses a quarter of the book, and the Arabic purpose asserts the pages contain "definitions and examples" when they contain vocabulary gap-fills and letters.
8. **`section` is empty on 12 of 24 pages while the heading is printed and searchable on 4 of them.** p009 `text` literally contains "Literature Focus Section 5" yet `section === ""`; likewise p011, p013, p015. *Consequence:* section-grouped retrieval drops half the book; and where it does fire, the key collides — p005 and p017 are both `Literature Focus Section 3` (different plays).
9. **The letter-scaffold convention is never explained anywhere.** Across 9 pages and 57 gaps the page prints `f______`, `g -u`, `g -h`, `s______`; the index keeps only the letter. *Consequence:* the model either reports the letter as the answer or refuses, and no user can be told what the convention means.
10. **No page states that this volume contains no answer key.** Measured across all 24 pages: `answer key` = 0, `الإجابات` = 0, `مفتاح` = 0, `Teacher's Book` = 0. *Consequence:* the most common question about an exercise book — "what is the answer?" — gets a hallucinated citation instead of "the answers are in the Teacher's Book, which is not part of this file".
11. **The 12 extract cross-references are structurally invisible.** `on page 101 of the Student's Book` … `on page 125` appear in `text` on p001, 003, 005, 007, 009, 011, 013, 015, 017, 019, 021, 023 and in **no** `title`, `summary` or `keyword`. *Consequence:* the model answers exercise questions without knowing the student is expected to read an extract in a different book, and never volunteers the page number.
12. **Keyword slots are 52.8% English stopwords; 10 pages are polluted with print debris.** 152/288 slots are function words (`the` on all 24 pages; p021's full list is `the, oliver, and, orlando, to, you, in, from, that, frederick, about, tell`). p006 carries `iraq` (the press slug) plus `173`; nine more pages carry a bare printed page number as a keyword. *Consequence:* the 12-slot budget is largely wasted, so topical terms like `Phoebe`, `Silvius`, `Jacques` are displaced, and "search for Iraq" or "search for 181" returns meaningless hits.

---

## Exercises-specific gaps

This is the class of loss unique to a *workbook*; a textbook audit would not surface any of it.

**E1 — Gap-fill underscores lost (9 pages, 57 markers).** The extractor deletes the rule and keeps the letter. Printed vs indexed:
- p002 C1: `a large amount of money = f______` → `1 a large amount of money = f`; C3 `adult = g -u______` → `3 adult = g -u`
- p004 C1: `a good number of = s______` → `1 a good number of = s`
- p006 D: `fear = a`, `missing = l`, `messy = u`, `not caring much = i`, `a lot, too much = e` (5)
- p008 C7: `thought = r______` → `7 thought = r`
- p010 D: `hate = d`, `to make something known = r` (6)
- p012 C: `nice, kind = g`, `clearly = f`, `time = p`, `worth a lot = v`, `without luck = u`, `discuss, fight = a` (6)
- p014 D: `1 will =`, `you =`, `three times =`, `your/yours =`, `someone silly =`, `unliked =` (6) — rules with **no** letter at all
- p016 C: `a lady =`, `overheard =`, `often =`, `remember =`, `did =`, `have =`, `your =` (7)
- p020 D: `you =`, `it's =`, `most fragile =`, `my =`, `tell =` (5)
None of the 57 survives as a blank in any index field. The word-length signal (how long the answer must be) is therefore unrecoverable everywhere.

**E2 — Answer checkboxes and ruled answer lines: 0 of ~160 represented.** The images show roughly 60 tick-boxes (T/F, ordering, match-the-column gutters) and ~90 ruled writing lines across the 24 pages, including 5 ordering boxes on p011, 13 full-width lines on p006, ~16 short rules on p018, ~15 on p014, ~10 on p020, ~9 on p024. `fullText` contains **zero** box glyphs; the ruling is not in the text layer at all. No `title`, `summary`, `preview`, `keyword` or `outlineSummary` mentions any of them. A question like "how many lines do I get for Exercise E on printed 191?" is unanswerable, and "do I tick a box or write a sentence?" cannot be answered on any of the 24 pages.

**E3 — Missing exercise letters and item counts.** Letters survive only inside the prose (`A Read the extract…`, `C Find a word in the text that means:`), never as a field. Counts are absent on 10 pages, and where a count *is* present it is unreliable:
- missing entirely: p005 A=5, p007 A=6/B=6, p011 A=5, p013 A=4, p017 A=5, p018 D=6, p020 D=5, p021 B=5-of-7, p023 C=4-of-5, p024 D=7
- wrong: p013 summary says "five events" (4)
- split across pages and stated **only in the Arabic `title`**: p021 (`B يبدأ هنا ويُكمَل في الصفحة 189`) and p023 (`C يبدأ هنا ويُكمَل في الصفحة 191`). `summary` and `text` never say it, so any path that ignores `title` computes B=5 instead of 7 and C=4 instead of 5.

**E4 — The Student's Book cross-reference, and the absent answer key.** 12 pages (p001, 003, 005, 007, 009, 011, 013, 015, 017, 019, 021, 023) open with `Read the extract(s) from … on page NNN of the Student's Book` (101, 103, 105, 107, 109, 111, 115, 117, 119, 121, 123, 125). `Activity Book` appears **0** times in this book. Critically, the reference is to the *extract*, not to answers: the only occurrences of "answer" are the instruction `Read the extract again and answer the questions`. There is no answer key anywhere in the 24 pages and the index never says so, so a student asking for answers gets a fabricated location.

**E5 — Re-ordering vs matching structure.** 7 re-ordering pages (p005, p011, p013, p017, p019, p022, p024) and 4 match-the-column pages (p005 B, p013 C, p020 C, p023 B) exist in the index only as prose. The instruction survives (`put the events in the order they happened`, `Match the columns`), but:
- nothing marks the events as **deliberately shuffled**, so the printed order reads as chronological and the model can "answer" by echoing it;
- the match grid's tick column (5 boxes on p013, 4 on p020, 6 on p023) is invisible, so the model cannot state the answer format (letter or number);
- p024 D shows the sharpest artefact: the pre-printed digits inside boxes 2 and 3 are extracted as line numbers — `…met with an old religious man. 2 I am the second son…` / `…kill his brother. 3 I swear on my life…` — so the model sees a malformed numbered list of 5, when the exercise actually has **7** boxes.

**E6 — `pageType` wrongly `lesson_content` on 6 exercise pages.** p004, p006, p014, p018, p020, p024 are exercises C/D/E pages, yet typed `lesson_content` while p003, p005, p013, p017, p019, p021, p023 — pure exercises too — are correctly typed `exercises`. Root cause: `scripts/build-index.mjs:131` copies `page.pageType` from `pdf-index.json` with no validation, and the mis-typed pages all inherit the generic `educationalPurpose` `"قراءة التعريفات والأمثلة والمحتوى التعليمي."` through `scripts/build-index.mjs:132`. An exercise-page filter loses 25% of the book; a "definitions" query returns writing pages.

---

## Quantitative totals

| Metric | Value |
|---|---|
| Physical pages | **24** (printed 168–191, continuous) |
| Searchable / vision pages | **24 / 0** (`searchablePageCount: 24`, `visionPageCount: 0`) |
| Total `text` chars (index) | **23,009** |
| Total `preview` chars | **22,456** |
| **Chars lost to the 1,200-char preview cap** | **553 (2.40%)** |
| Pages with preview truncation | **5** — p003 (70), **p009 (259)**, p015 (146), p021 (8), p022 (70) |
| **Worst page** | **p009 / printed 176 — 259 chars lost (17.8% of the page)**, cut mid-word at `…Elizabeth's dislike for Mr Darcy only grew after learn` |
| `text` complete in index | **24 / 24** — `documents[].text.length === pdf-books.fullText.length` on every page; **0 words lost** |
| `preview` reaches the model? | **Yes, 24/24** — `lib/index.mjs:418` `fullPage()` reloads full text; budget 6,000 ≫ max page 1,459 |
| Pages with a **false claim** in `title` or `summary` | **3** (p008 title, p010 summary, p013 summary) |
| Pages with an **implied but unstated** structure count | **10** |
| Pages with empty `section` | **12** (4 with the heading actually printed) |
| Pages typed `lesson_content` though pure exercises | **6** |
| Pages with a false `educationalPurpose` | **6** (all 6 `lesson_content` pages) |
| **Undocumented visual structures** | **8 distinct classes, on 24/24 pages** — (1) T/F + ordering + match tick-boxes, (2) ruled short-answer lines, (3) full-width writing blocks, (4) gap-fill rules/underscores, (5) the `L` unit tab (with its alternating left/right position), (6) play running-head plate, (7) CMYK calibration bars + 3 registration crosshairs, (8) crop marks |
| Answer checkboxes in images vs in index | **~60 vs 0** |
| Ruled answer/writing lines in images vs in index | **~90 vs 0** |
| Gap markers in images vs in index | **57 vs 0** (9 pages); 2 pages additionally leak the answer inline |
| Box glyphs in `fullText` | **0** |
| Underscore runs in `fullText` | **0** |
| Press-slug chars inside `text` | **2,040 (8.9% of 23,009)** — 85 chars × 24 pages |
| Keyword slots polluted by English stopwords | **152 / 288 (52.8%)** — all 24 pages; `the` is a keyword on all 24 |
| Keyword slots polluted by print debris | **10** — 9 bare printed page numbers (p002, 004, 006, 010, 011, 012, 014, 018, 020) + `iraq` (p006) |
| `Student's Book` cross-references | **12** (in `text` only; **0** in `title`/`summary`/`keywords`) |
| `Activity Book` references | **0** |
| Answer-key mentions (`answer key` / `الإجابات` / `مفتاح` / `Teacher's Book`) | **0 / 0 / 0 / 0** — the volume ships no key and the index never declares it |
| `PAGE_NUMBER_MISMATCH` | **0** |
| `LENGTH_FIELD_MISMATCH` (sub-audits claimed 22–23) | **0** — audit artefact, see §2.1 |
| `META_TEXT_LEAK` in the index (sub-audit claimed 12) | **0** — `reviewNotes`/`reviewed` never copied |
| `WORD_LEVEL_TEXT_LOSS` | **0** — book typos faithfully preserved (p008 "blame someone **of** something", p010 "Why is Mr Darcy **reddish**") but propagated without `[sic]` |

### Cheapest high-value fixes (all verified in code)

1. `lib/text.mjs:18-27` — add an English stopword set (~60 words). Recovers ~152 keyword slots across the book at zero schema change.
2. `scripts/build-index.mjs:15-18` — extend the existing `/indb|iraq_g12/i` filter (already used at `:33,37,44,50`) into `usableText()`. Removes 2,040 chars of press debris from `text`, `preview`, `normalized` and the postings — and with it the p003/p015/p021/p022 truncations.
3. `scripts/build-index.mjs:108` + `lib/text.mjs:114-116` — replace the blind `.slice(0, 1200)` with head+tail and an explicit `…N chars omitted…` marker, so `preview` can never silently imply completeness.
4. `scripts/build-index.mjs:129` / `lib/outline.mjs:82-88` — emit a `section` key from the outline (which already carries it inside `title`) and qualify it by play, e.g. `Pride and Prejudice — Section 3`, so the key stops colliding between the two halves of the book.
5. `scripts/build-index.mjs:131-132` — validate `pageType` against the presence of exercise letters (`/^A\s/m … /^E\s/m` in `fullText`) and derive `purpose` from the exercises present rather than copying `educationalPurpose`.
6. `scripts/build-index.mjs:43-44` — cross-check the reviewed `summary` against `fullText` for numeric claims (p013 "five" vs 4 items) and reject on mismatch.
7. New field: `answerMechanism` + `itemCounts` per exercise letter, emitted next to `:133-135`, plus an `answerKeyAvailable: false` book-level flag derived at `:94` from `referenceKind === 'official-exercises'`.
