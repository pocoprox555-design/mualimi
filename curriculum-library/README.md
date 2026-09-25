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

الفهرس النصي الموحد في `search-index.json` يبني postings من كامل `fullText`، ويحتفظ بمعاينة ووصف فهرسي مساعد للصفحات المصورة. فتح النص الكامل يتم عند الطلب لصفحات محددة، ولا يُعامل الوصف الفهرسي كاقتباس من PDF ولا تُرسل ملفات PDF كاملة إلى النموذج.
- `npm test` — اختبارات parser والتطبيع والبحث والأمان.

## حقوق المحتوى

لا تضف كتابًا من مرآة غير رسمية إلا إذا كان لديك حق قانوني لاستخدامه. `sources.json` كتالوج متابعة ولا يمنح إذنًا بالتنزيل أو إعادة التوزيع.
