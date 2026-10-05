# معلمي — تعليمات النشر والتحديث

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

## تعديل المتغيرات (مثل AI_API_KEY)
1. افتح https://dashboard.render.com
2. اختر خدمة `mualimi`
3. Environment → عدّل المتغير → Save
4. يعيد البناء تلقائيًا

## المتغيرات المطلوبة
| المفتاح | القيمة |
|---------|--------|
| `AI_API_KEY` | مفتاح المزود؛ يمكن إدخاله مباشرة في Environment في Render، والبادئة `b64:` مدعومة |
| `AI_ENDPOINT` | `https://opencode.ai/zen/go/v1` |
| `AI_MODEL` | `mimo-v2.6-flash` (والاسم القديم يُحوّل تلقائيا) |
| `AI_CONTEXT_WINDOW` | `1000000` |
| `AI_MAX_OUTPUT_TOKENS` | اختياري؛ الافتراضي 3000 ويُحدّ الخادم إلى 16,000 كحد أقصى |

## البحث الاحتياطي على الويب
| المفتاح | القيمة |
|---------|--------|
| `WEB_SEARCH_API_KEY` | مفتاح Brave Search؛ مطلوب لتفعيل البحث الخارجي |
| `WEB_SEARCH_ENDPOINT` | اختياري؛ الافتراضي `https://api.search.brave.com/res/v1/web/search` |

لا يُستدعى بحث الويب إلا بعد استرجاع المنهج ومحاولة فتح صفحة PDF المطلوبة، وعند غياب دليل محلي موثوق. إعداد مفتاح البحث اختياري.

## ملاحظات تقنية
- Dockerfile يستخدم `node:22-alpine`
- مرحلة البناء تثبّت الاعتماديات من `package-lock.json` وتشغّل `npm run verify`؛ تحتاج `curriculum-library/pdf-sources` و`pdf-books` للتحقق.
- الصورة النهائية لا تتضمن أدوات البناء والاختبارات؛ تنسخ `search-index.json` و`pdf-index.json` و`pdf-books` و`outlines` و`pdf-sources` اللازمة للتشغيل وقراءة PDF الاحتياطية.
- الخادم يستمع على `PORT` (Render يضبطه تلقائيًا)
- الطبقة المجانية: يتوقف بعد 15 دقيقة خمول (~50 ثانية تأخير عند أول طلب)
- لا تعدّل `.env` ولا ترفعه — محجوب في `.gitignore` و`.dockerignore`
