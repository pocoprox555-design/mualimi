# معلمي — تعليمات النشر والتحديث

> اقرأ `README.md` (هوية التطبيق) و`MEMORY.md` قبل أي تعديل. خرق الشروط في README يخرب التطبيق.

## منصة النشر

- **المنصة:** Render (مجاني، بلا بطاقة)
- **الرابط:** https://mualimi.onrender.com
- **المستودع:** https://github.com/pocoprox555-design/mualimi
- **الفرع:** `main`

## كيفية التحديث (كل تعديل)

```bash
git add -A
git -c user.name='Mualimi' -c user.email='deploy@mualimi.local' commit -m "وصف التعديل"
git push
```

Render يعيد البناء تلقائيًا (~2-3 دقائق). لا حاجة لأي أمر إضافي.

> إذا عدّلت `pdf-books/*.json` يدوياً فشغّل `npm run verify` محلياً أولاً — وإلا ستنشر `pdf-index.json`/`search-index.json` قديمين.

## تعديل المتغيرات (مثل AI_API_KEY أو AI_MODEL)

1. افتح https://dashboard.render.com
2. اختر خدمة `mualimi`
3. Environment → عدّل المتغير → Save (يعيد البناء تلقائياً)
4. لتغيير النموذج: غيّر `AI_MODEL` فقط (مثلاً `mimo-v2.6-flash` ↔ `deepseek-v4-flash-vision-exp` للصور) — بلا كود

## المتغيرات المطلوبة

| المفتاح | القيمة |
|---------|--------|
| `AI_API_KEY` | مفتاح المزود؛ يُدخل في Environment في Render، والبادئة `b64:` مدعومة |
| `AI_ENDPOINT` | `https://opencode.ai/zen/go/v1` |
| `AI_MODEL` | `mimo-v2.6-flash` — غيّره لأي نموذج من نفس المزود بلا كود. للصور اختر نموذج vision مثل `deepseek-v4-flash-vision-exp` |
| `AI_CONTEXT_WINDOW` | `1000000` |
| `AI_MAX_OUTPUT_TOKENS` | اختياري؛ الافتراضي `8000` والخادم يحدّه إلى `16,000` |

## البحث الاحتياطي على الويب (اختياري)

| المفتاح | القيمة |
|---------|--------|
| `WEB_SEARCH_API_KEY` | مفتاح Brave Search |
| `WEB_SEARCH_ENDPOINT` | اختياري؛ الافتراضي `https://api.search.brave.com/res/v1/web/search` |

لا يُستدعى بحث الويب إلا بعد استرجاع المنهج ومحاولة فتح صفحة PDF المطلوبة، وعند غياب دليل محلي موثوق.

## ملاحظات تقنية

- `node:22-alpine` — `npm ci` من `package-lock.json` ثم `npm run verify` (يحتاج `curriculum-library/pdf-sources` و`pdf-books`)
- الصورة النهائية تنسخ `search-index.json` و`pdf-index.json` و`pdf-books` و`outlines` و`pdf-sources` للتشغيل
- الخادم يستمع على `PORT` (Render يضبطه تلقائيًا)
- الطبقة المجانية: ينام بعد 15 دقيقة خمول (~50 ثانية صحوة عند أول طلب)
- لا تعدّل `.env` ولا ترفعه — محجوب في `.gitignore` و`.dockerignore`
- لا تضف `Rate Limit` أو قيوداً — التطبيق خاص لرحمة

## مشكلة "صفحة بيضاء" — لا تلمس بلا فهم

إن ظهرت صفحة بيضاء بعد تعديل الواجهة، فالسبب غالباً **`bindEvents()` يرمي استثناء قبل `enterApp()`** (مثلاً `$('#examForm').addEventListener` على عنصر غير موجود بعد حذف `view-plan`). الحل المطبق في `public/app.js`: كل `getElementById` مشروط بـ `?.` و`bindEvents` داخل `try/catch`. لا تحذف الحراس.

## مشكلة الصور `Cannot read "image.png"`

`mimo-v2.6-flash` لا يدعم `image_url`. السيرفر الحالي يرسل الصور فقط إذا كان النموذج vision، وإلا يحوّلها لملاحظة نصية بلا خطأ. إن أردت قراءة الصور غيّر `AI_MODEL` في Render.
