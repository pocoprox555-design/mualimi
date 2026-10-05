# معلمي — معلمك الخاص للسادس الإعدادي

> تطبيق خاص للطالبة **رحمة** — مسار **التعليم الديني** للسادس الإعدادي العراقي. معلم خاص ذكي يفهم النية بنفسه كإنسان، يعرف المنهج **صفحة صفحة** (21 كتاب / 2342 صفحة)، ويشرح أي صفحة تُطلب فوراً بلا أعذار.

- **الرابط:** https://mualimi.onrender.com — **المستودع:** https://github.com/pocoprox555-design/mualimi — **الفرع:** `main`
- **النموذج الافتراضي:** `mimo-v2.6-flash` عبر `https://opencode.ai/zen/go/v1` — يمكن تغييره من Render بلا كود
- **التشغيل:** `Node.js >=22.3.0` — خادم واحد `server.mjs` — صفر اعتماديات تشغيل ثقيلة

---

## هوية التطبيق — اقرأ هذا أولاً قبل أي تعديل

**معلمي ليس بوت أسئلة عامة.** هو:

1. **معلم خاص لرحمة وحدها** — يخاطبها بصيغة المؤنث، بلمسة عراقية دافئة، كأم ثانية. يعرف مسارها (ديني) ويستخدم كتبه أولاً، لكنه يجيب عن أي مادة بذكاء بلا رفض غبي.
2. **مطّلع على المنهج كاملاً حرفياً** — كل صفحة لها `fullText` مستخرج نصاً في `curriculum-library/pdf-books/*.json` (مثال: رياضيات ديني 80 صفحة، فقه شافعي 106، حديث 159…). السيرفر يقرأ منها مباشرة، فلا يصح أن يقول "ما عندي وصول" أو "حطي نص الصفحة".
3. **يفهم النية بنفسه (LLM-only)** — لا توجد قوائم كلمات مفتاحية في الكود. النموذج نفسه يصنف: `تحية وديّة → conversation` / `سؤال منهجي/صفحة → curriculum` / `سؤال عن الكتب → catalog` / `خارجي تماماً → external`. أي `if (text.includes("كيفك|مرحبا"))` داخل السيرفر هو تخريب.
4. **يشرح صفحات متعددة معاً** — "صفحة 22 من الرياضيات و 42 من الفقه" تُجلب متوازياً بـ `Promise.all` ويُشرح كل كتاب بعنوانه. لا يختزل إلى صفحة واحدة.
5. **واجهة فاخرة هادئة 60fps** — ترابية (`paper #f4f2ed` + `teal #287e78` + `gold #c9954a` + `deep #0f2d38`)، خط `Tajawal 400/700/800`، جوال احترافي: `mobile-nav` ثابت، `sidebar` من اليمين (RTL) مع `overlay` وقفل `scroll` وإغلاق بـ `Esc`، كل الأزرار `44px`، لا نيون بنفسجي.

**ما ليس من هوية التطبيق:** لا صفحات "خطتي/الاختبارات الوهمية" الزائدة (حُذفت في v5 وبقي `التعلم + جلساتي` فقط)، لا `Rate Limit` على رحمة (التطبيق خاص)، لا إضافات مدفوعة إلا مفتاح الذكاء نفسه.

---

## كيف يعمل — مسار الإجابة الحقيقي

```
رحمة تكتب → planIntent (LLM يفهم النية JSON) → [conversation؟ → رد ودي مباشر بلا بحث]
                                          → curriculum؟ → extractPageRequests (مرن، يلتقط كل "صفحة N")
                                                        → resolveBook لكل طلب
                                                        → Promise.all(retrieveExactPage) من pdf-books/fullText + search-index
                                                        → بناء prompt: systemPrompt + المصادر + (صور إن وجدت)
                                                        → streamCompletion (SSE) → رحمة ترى الكتابة حيّة
```

- **التحية:** تُكتشف عبر النموذج، فلا يُستدعى أي بحث. السيرفر يرسل `conversation` فارغاً ويبث رداً إنسانياً دافئاً.
- **الصفحة المحددة:** تُؤخذ من `pdf-books/<bookId>.json → pages[].fullText` مباشرة. إن فشل النص يُحاول فتح `pdf-sources/*.pdf` لصورة بصرية. لا يُطلب من الطالبة شيء.
- **السؤال العام:** أقوى 8 نتائج من `search-index.json` (فهرس مقلوب 34MB) + نصوصها الكاملة من `pdf-books` تُحقن في الـ prompt. إن لم يوجد دليل يشرح المعلم من خبرته مع توضيح أنها ليست اقتباساً حرفياً.
- **الصور المرفوعة:** العميل يضغطها بـ `canvas` إلى `JPEG ≤800k` ويرسل `data:image/jpeg;base64,…` (حتى صورتين). السيرفر يرسلها فقط إذا كان النموذج يدعم `vision` (مثلاً `deepseek-v4-flash-vision-exp`)، وإلا يحوّلها لملاحظة نصية بلا خطأ. خطأ `Cannot read "image.png"` كان سببه إرسال الصورة لجولة التخطيط غير البصرية — أُصلح بإرسال نص بديل هناك.

---

## طبقات المنهج — لا تلمس بلا فهم

| الطبقة | ما هي | لا تلمس؟ |
|---|---|---|
| `pdf-sources/*.pdf` | **مصدر الحقيقة** — 21 PDF رسمي | ⛔ لا تحذف نهائياً |
| `pdf-books/<id>.json` | صفحة بصفحة: `fullText`, `title`, `summary`, `pageType`, `printedPage` | تعديله لا يصل للتشغيل إلا عبر الجسر التالي |
| `pdf-index.json` | مجمّع من `pdf-books` | يُبنى بـ `npm run rebuild-pdf-index` |
| `search-index.json` | **مصدر الحقيقة وقت التشغيل** — فهرس مقلوب + نصوص | يُبنى بـ `npm run build-index` |
| `outlines/<id>.md` | خريطة وصفية للتنقل فقط | ليست نصاً للاقتباس |
| `enrichment/<id>.json` | تغذية منظمة (glossary/figures/…) | 20/21 مكتمل |

**التسلسل الإلزامي:** `pdf-books` → `rebuild-pdf-index` → `build-index` → `search-index.json` → `npm test` → `npm run gate`. تشغيل `build-index` مع `import-deni` معاً يفسد الفهرس.

الإحصاء الحقيقي: **2342 صفحة**، منها **2266 بـ fullText صالح (~96.8%)**، و45 صفحة من `fiqh-hanafi` بلا طبقة نص أصلاً (نص متجهي).

---

## التشغيل المحلي

```bash
npm ci
npm run verify   # rebuild-pdf-index + build-index + gate + test (81/81)
npm start        # http://localhost:3000
```

يتطلب `curriculum-library/pdf-sources` و`pdf-books` للتحقق. `npm run verify` يفشل بلا ملفات المنهج — هذا مقصود.

---

## النشر — Render (مجاني)

انظر `AGENTS.md` للتفصيل. الخلاصة:

```bash
git add -A
git -c user.name='Mualimi' -c user.email='deploy@mualimi.local' commit -m "وصف التعديل"
git push   # Render يبني تلقائياً 2-3 دقائق
```

**المتغيرات في Render → Environment:**

| المفتاح | القيمة |
|---|---|
| `AI_API_KEY` | مفتاحك (`b64:` مدعوم) |
| `AI_ENDPOINT` | `https://opencode.ai/zen/go/v1` |
| `AI_MODEL` | `mimo-v2.6-flash` — غيّره لأي نموذج من نفس المزود بلا كود (مثلاً `deepseek-v4-flash-vision-exp` للصور) |
| `AI_CONTEXT_WINDOW` | `1000000` |
| `AI_MAX_OUTPUT_TOKENS` | `8000` (السقف 16000) |

الطبقة المجانية تنام بعد 15 دقيقة خمول (~50 ثانية صحوة).

---

## شروط صارمة — تخريب التطبيق يبدأ من هنا

1. **لا تضف قائمة كلمات للنية.** `if (msg.includes("كيفك|مرحبا|شلونك"))` ممنوع. الفهم LLM فقط عبر `PLAN_INSTRUCTIONS` + `systemPrompt`.
2. **لا تطلب من رحمة نص الصفحة.** النص في `pdf-books/fullText`. إن لم تجده اشرح من خبرتك، لا تعتذر بـ "ما عندي وصول".
3. **لا تغيّر `curriculum-library` ثم ترفع بلا `verify`.** ستنشر فهرساً قديماً.
4. **لا تضف `Rate Limit` أو قيود غبية.** التطبيق خاص.
5. **لا تضع `AI_API_KEY` في الكود.** فقط `Render Environment` أو `local .env` (محجوب بـ `.gitignore`/`.dockerignore`).
6. **لا ترفع `.env`.** ولا تغيّر `Dockerfile` لنسخ أسرار.
7. **لا ترجع صفحة "خطتي" أو واجهات زائدة** بلا طلب صريح — v5 ثنائية فقط (تعلم + جلساتي).
8. **الصور:** لا ترسل `image_url` لنموذج لا يدعم `vision` (مثل `mimo-v2.6-flash`). الكود الحالي يحوّلها لملاحظة نصية ويبث بلا خطأ. إن أردت قراءة الصور غيّر `AI_MODEL` في Render إلى نموذج vision.
9. **اقرأ `MEMORY.md` قبل أي تعديل** — فيه كل قرار وتخريب سابق وكيف أُصلح.

---

## البنية الحالية (v5)

```
server.mjs            خادم HTTP أصلي — ~2000 سطر (نية LLM + جلب متوازي + بث)
lib/config.mjs        DEFAULT_MODEL=mimo-v2.6-flash
lib/provider.mjs      SSE + retry قبل أول رمز فقط
lib/index.mjs         retrieveContext من search-index
lib/text.mjs          تطبيع عربي شامل
lib/pdf-fallback.mjs  قراءة PDF الأصلي للصور
public/index.html     v5 — تعلم + جلساتي فقط
public/style.css      v5 — ترابي هادئ 60fps + جوال RTL
public/app.js         v5 — sidebar overlay + Esc + throttle 50ms
curriculum-library/   المنهج كاملاً (لا يُمس)
```

الاختبارات: `81/81` — البوابة: `validate-index.mjs` (25 فحصاً).

> أي مفتاح ظهر في سجل → ألغِه من المزود فوراً.
