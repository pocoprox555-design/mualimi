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
| `AI_API_KEY` | b64:... (من ملف .env) |
| `AI_ENDPOINT` | `https://opencode.ai/zen/go/v1` |
| `AI_MODEL` | `mimo-v2.6-flash` (بحالة صغيرة حتمًا — الكبيرة تُرفض) |
| `AI_CONTEXT_WINDOW` | `1000000` |
| `AI_MAX_OUTPUT_TOKENS` | `131000` |
| `CURRICULUM_ADMIN_TOKEN` | رمز عشوائي |

## ملاحظات تقنية
- Dockerfile يستخدم `node:22-alpine`
- الخادم يستمع على `PORT` (Render يضبطه تلقائيًا)
- الطبقة المجانية: يتوقف بعد 15 دقيقة خمول (~50 ثانية تأخير عند أول طلب)
- لا ت修改 `.env` وترفعه — محجوب في `.gitignore`
