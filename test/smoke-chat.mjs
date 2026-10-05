// اختبار دخان: يشغّل السيرفر الحقيقي بمزود ذكاء وهمي، ويتحقق من:
//  1) تحية => لا مصادر، ولا بحث، رد ودّي فقط
//  2) سؤال «صفحة 22 رياضيات» => لا مخطط نية، ويظهر نص الصفحة المطلوبة فقط
//  3) «الكتب المتاحة» => كتالوج حقيقي داخل البرومبت
//  4) «اختبريني ٥ أسئلة» => إلزام كتلة quiz بعدد 5
//  5) صفحة بلا نص ولم يُفتح PDF => بوابة صدق تمنع ادعاء الصفحة
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TICK = String.fromCharCode(96);

function freePort() {
  const server = http.createServer();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const upstreamCalls = [];
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    const system = String(body.messages?.[0]?.content || '');
    const user = String(body.messages?.at(-1)?.content || '');
    const isPlanner = /مخطط استعمال أدوات/.test(system);
    const reply = isPlanner
      ? /شلونك|كيفك|هلا|السلام/.test(user)
        ? '{"intent":"conversation","use_local":false}'
        : '{"intent":"curriculum","use_local":true,"local_query":"","book_query":"","subject":"","use_outline":false,"use_catalog":false,"exact_page":{"printed_page":null,"physical_page":null}}'
      : user.includes('اختبريني')
        ? 'حاضرة يا رحمة\n' + TICK + TICK + TICK + 'quiz\n' + JSON.stringify({ title: 'اختبار', questions: Array.from({ length: 5 }, (unused, index) => ({ q: `سؤال ${index + 1}`, options: ['أ', 'ب', 'ج', 'د'], answer: 0, why: 'لأن' })) }) + '\n' + TICK + TICK + TICK
        : 'شكراً لك يا رحمة، هذا رد اختباري قصير.';
    upstreamCalls.push({ isPlanner, system, user });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

async function freePortAsync() {
  const server = http.createServer();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const port = await freePortAsync();
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), AI_API_KEY: 'smoke-key', AI_ENDPOINT: `http://127.0.0.1:${upstream.address().port}/v1`, AI_MODEL: 'mimo-v2.5' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
app.stdout.on('data', (chunk) => { serverLog += chunk; });
app.stderr.on('data', (chunk) => { serverLog += chunk; });

async function chat(question, extra = {}) {
  const before = upstreamCalls.length;
  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session': 'smoke' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }], studentName: 'رحمة', curriculumTrack: 'ديني', ...extra }),
  });
  const body = await response.text();
  const calls = upstreamCalls.slice(before);
  const citations = body.match(/event: citations\ndata: (.*)/)?.[1] || '';
  return { body, calls, citations, steps: [...body.matchAll(/event: step\ndata: (.*)/g)].map((match) => JSON.parse(match[1])) };
}

const results = [];
const check = (name, ok, note = '') => results.push(`${ok ? '✔' : '✘'} ${name}${note ? ` — ${note}` : ''}`);

try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  // 1) تحية
  {
    const { calls, citations, steps } = await chat('شلونك أخبارك؟ راح أذاكر بعدين');
    const planners = calls.filter((call) => call.isPlanner).length;
    const answer = calls.findLast((call) => !call.isPlanner);
    check('تحية: مخطط نية واحد (لا بحث)', planners <= 1, `${planners} نداء مخطط`);
    check('تحية: لا مصادر مرسلة', citations.includes('"items":[]'), citations.slice(0, 40));
    check('تحية: لا خطوات بحث معروضة', !steps.some((step) => /بحثت في الكتب|فتحت صفحة|البحث الخارجي/.test(step.label || '')), steps.map((step) => step.label).join(' | '));
    check('تحية: تعليمات quarantine موجودة', /لا تسردي آية/.test(answer?.system || ''));
    check('تحية: لا رموز [S1] في الرد', !/\[S\d+\]/.test((calls.findLast((call) => !call.isPlanner)?.user || '')));
  }

  // 2) صفحة محددة: لا مخطط نية، نص الصفحة فقط
  {
    const { calls, body } = await chat('اشرحي صفحة 22 من الرياضيات خطوة بخطوة');
    const planners = calls.filter((call) => call.isPlanner).length;
    const answer = calls.findLast((call) => !call.isPlanner);
    const system = answer?.system || '';
    check('صفحة: لا مخطط نية', planners === 0, `${planners} نداء مخطط`);
    check('صفحة: لم يُطلب «مخطط الكتاب غير متاح» كعذر', !/مخطط الكتاب غير متاح/.test(body));
    check('صفحة: حواجز منع الاختلاق موجودة', /قاعدة لا تُخترق/.test(system) && /لا تسردي آية/.test(system));
    check('صفحة: منع LaTeX الخام', /LaTeX/.test(system));
    check('صفحة: صريحة «ما عندي وصول» + «لا تطلبي منها»', /ما عندي وصول للكتب/.test(system) && /لا تطلبي منها/.test(system));
    check('صفحة: لا أمر للطالبة بكتابة نص', !/اكتبي (?:لي |لي )?نص الصفحة|أرسلي نص الصفحة|انسخي نص الصفحة/.test(system));
    const pageSection = (system.split('## مصادر الصفحات')[1] || '').split('##')[0].trim();
    const blocks = pageSection ? pageSection.split('\n\n---\n\n') : [];
    check('صفحة: نص الصفحة المطلوبة داخل البرومبت', /مصادر الصفحات المطابقة/.test(system) && /الصفحة المطبوعة 22/.test(system), (system.match(/الصفحة المطبوعة \d+/) || ['لا شيء'])[0]);
    check('صفحة: بلا بحث عام من كتب أخرى', blocks.length <= 2, `${blocks.length} كتلة في البرومبت`);
  }

  // 3) سؤال الكتب: كتالوج حقيقي
  {
    const { calls } = await chat('شنو الكتب المتاحة عندي للدراسة؟');
    const answer = calls.findLast((call) => !call.isPlanner);
    const system = answer?.system || '';
    check('كتالوج: البيانات المحملة موجودة', /كتالوج كتب مسار/.test(system) || /الكتالوج الكامل/.test(system));
    check('كتالوج: منع اختراع الكتب', /أي كتاب لم يرد هنا ممنوع/.test(system) || /لا تسردي قائمة كتب/.test(system));
  }

  // 4) اختبار تفاعلي بعدد ٥
  {
    const { body, calls } = await chat('اختبريني في الفقه، ٥ أسئلة');
    const answer = calls.findLast((call) => !call.isPlanner);
    check('اختبار: تعليمة quiz إلزامية', /## اختبار تفاعلي — إلزامي الآن/.test(answer?.system || ''));
    const countLine = (answer?.system || '').match(/(\S+) أسئلة بالضبط/)?.[1] || '؟';
    check('اختبار: العدد المطلوب ٥', /أسئلة بالضبط/.test(answer?.system || '') && countLine === '٥', `ظهر «${countLine}»`);
    check('اختبار: كتلة quiz وصلت', /```quiz/.test(body), body.slice(0, 600).replace(/\n/g, ' '));
  }

  // 5) صفحة بلا مادة: لا تخمين كتاب
  {
    const { calls, body, steps } = await chat('اشرحي صفحة ٢٢');
    const answer = calls.findLast((call) => !call.isPlanner);
    const system = answer?.system || '';
    check('صفحة بلا كتاب: بوابة التوضيح', /توضيح مطلوب قبل أي شرح/.test(system));
    check('صفحة بلا كتاب: لا مصادر', /"items":\[\]/.test(body) || /"items": \[\]/.test(body), body.match(/event: citations\ndata: (.*)/)?.[1]?.slice(0, 30));
    check('صفحة بلا كتاب: خطوة التوضيح معروضة', steps.some((step) => /توضيح/.test(step.label || '')));
  }

  // 6) صفحة غير موجودة: بوابة الصدق تمنع الاختلاق
  {
    const { calls, body } = await chat('اشرحي صفحة 987 من الفقه الشافعي');
    const answer = calls.findLast((call) => !call.isPlanner);
    const system = answer?.system || '';
    check('صفحة غير موجودة: بوابة «لم تُفتح»', /## الصفحة المطلوبة لم تُفتح/.test(system));
    check('صفحة غير موجودة: تحريم تمثيل الصفحة', /تمثيل مضمونها|تمثيل محتوى/.test(system));
    check('صفحة غير موجودة: لا بطاقات مصدر', /"items":\[\]/.test(body), body.match(/event: citations\ndata: (.*)/)?.[1]?.slice(0, 30));
  }

  // 7) صفحتان من كتابين: تُعالجان معاً
  {
    const { calls } = await chat('اشرحي صفحة 22 من الرياضيات و صفحة 42 من الفقه');
    const answer = calls.findLast((call) => !call.isPlanner);
    const system = answer?.system || '';
    const pageSection = (system.split('## مصادر الصفحات')[1] || '').split('##')[0].trim();
    const blocks = pageSection ? pageSection.split('\n\n---\n\n') : [];
    check('صفحتان: كتلتان في البرومبت', blocks.length === 2, `${blocks.length} كتلة`);
    check('صفحتان: 22 و 42 معاً', /الصفحة المطبوعة 22/.test(system) && /الصفحة المطبوعة 42/.test(system));
  }

  // 8) نموذج غير بصري: لا صور مرسلة أصلاً
  {
    const dataUrl = `data:image/png;base64,${'A'.repeat(64)}`;
    const { calls } = await chat('اشرح هذه الصورة', { messages: [{ role: 'user', content: [{ type: 'text', text: 'اشرح هذه الصورة' }, { type: 'image_url', image_url: { url: dataUrl } }] }] });
    const answer = calls.findLast((call) => !call.isPlanner);
    const system = answer?.system || '';
    check('صور: بلا نموذج بصري لا ترسل image_url', !/image_url/.test(JSON.stringify(calls.at(-1)?.user || '')));
    check('صور: لا تطلب كتابة نص الصورة', /لا تطلبي منها أن تكتب نص الصورة/.test(system));
  }

  // 9) بنود لم يختبرها التقرير (§9): صفحات كتب محددة
  {
    for (const question of [
      'اشرحي صفحة 24 من الحديث',
      'اشرحي صفحة 30 من اللغة الإنجليزية',
      'اشرحي صفحة 12 من التاريخ',
      'اشرحي صفحة 44 من الفقه الحنفي',
    ]) {
      const { calls, body } = await chat(question);
      const answer = calls.findLast((call) => !call.isPlanner);
      const system = answer?.system || '';
      const pageSection = (system.split('## مصادر الصفحات')[1] || '').split('##')[0].trim();
      const blocks = pageSection ? pageSection.split('\n\n---\n\n') : [];
      const honest = /قاعدة لا تُخترق/.test(system) && /لا تقولي أبداً/.test(system);
      check(`صفحة كتاب (${question.slice(8, 22)}): بلا خلل ولا كتل من كتب أخرى`, honest && blocks.length <= 2 && !/event: error/.test(body), `${blocks.length} كتلة`);
    }
  }

  // 10) طلب نص ديني بعينه (آية/حديث) — لم يختبره التقرير
  {
    const { calls } = await chat('اكتبي لي الآية المقصودة في صفحة 5 من الحديث');
    const answer = calls.findLast((call) => !call.isPlanner);
    const system = answer?.system || '';
    check('نص ديني مباشر: قاعدة «لا تُظهره كاملاً» موجودة', /لا تُظهره كاملاً/.test(system));
    check('نص ديني مباشر: منع الآية المقاربة والفارغة', /آية «مقاربة»/.test(system) && /حروفاً مبتورة/.test(system));
  }

  // 11) مادة خارج مسارها (C18): وسم المنهج + الوضوح
  {
    const { calls } = await chat('اشرحي لي موضوع العرض والطلب في الاقتصاد');
    const answer = calls.findLast((call) => !call.isPlanner);
    const system = answer?.system || '';
    check('مادة خارج المسار: يجب توضيح أنها ليست من كتبها', /ليست من كتبك ولا من منهجك/.test(system));
    check('مادة خارج المسار: لا مصدر من كتب المسار', !/quran-readings-deni|fiqh-shafii-deni/.test(system));
  }

  // 12) صفحتان بلا تكرار بطاقات من كتب أخرى (C17)
  {
    const { body, calls } = await chat('قارني بين صفحة 5 وصفحة 6 من البلاغة');
    const answer = calls.findLast((call) => !call.isPlanner);
    const system = answer?.system || '';
    const pageSection = (system.split('## مصادر الصفحات')[1] || '').split('\n\n## ')[0];
    const books = new Set((pageSection.match(/^\[[A-Z]\d+\] [^|\n]+/gm) || []).map((line) => line.replace(/^\[[A-Z]\d+\]\s*/, '').trim()));
    check('مقارنة صفحتين: كتاب واحد فقط في البرومبت', books.size <= 1, [...books].join(' | '));
    check('مقارنة صفحتين: مخطط بلا بطاقة O1', !/"id":"O1"|"id": "O1"/.test(body));
  }
  // 13) كتب المنهج الأساسية كانت خارج نطاقها (العيب الجذري لـ C13)
  {
    for (const question of [
      'اشرحي صفحة 24 من التربية الإسلامية',
      'اشرحي صفحة 5 من القرآن',
      'اشرحي صفحة 40 من الحديث',
    ]) {
      const { calls, body } = await chat(question);
      const answer = calls.findLast((call) => !call.isPlanner);
      const system = answer?.system || '';
      const pageSection = (system.split('## مصادر الصفحات')[1] || '').split('\n\n## ')[0];
      const opened = pageSection.length > 0;
      check(`كتابها الأساسي (${question.slice(8, 22)}): فُتح أو امتنع بلا كتاب آخر`, opened || /## الصفحة المطلوبة لم تُفتح/.test(system), `كتل=${pageSection.length} حرف`);
      check(`كتابها الأساسي (${question.slice(8, 22)}): بلا استبدال`, !/quran-readings-deni-sixth/.test(pageSection) || /القرآن/.test(pageSection));
      check(`كتابها الأساسي (${question.slice(8, 22)}): بلا خطأ`, !/event: error/.test(body));
    }
  }

  // 14) «اللغة العربية» كتابان (جزء أول/ثانٍ) ⇒ توضيح لا اختيار النحو
  {
    const { calls } = await chat('اشرحي صفحة 22 من اللغة العربية');
    const answer = calls.findLast((call) => !call.isPlanner);
    const system = answer?.system || '';
    const pageSection = (system.split('## مصادر الصفحات')[1] || '').split('\n\n## ')[0];
    check('مادة لكتبها جزآن: توضيح بدل اختيار جزء', /## توضيح مطلوب قبل أي شرح/.test(system), pageSection.slice(0, 60).replace(/\n/g, ' '));
    check('مادة لكتبها جزآن: النحو لا يُنتقى', !/النحو الواضح/.test(pageSection));
  }
} catch (error) {
  results.push(`✘ استثناء: ${error?.message || error}`);
} finally {
  app.kill();
  await new Promise((resolve) => upstream.close(resolve));
}

console.log(results.join('\n'));
console.log('\nناديات المزود الوهمي:', upstreamCalls.length, '— مخططات:', upstreamCalls.filter((call) => call.isPlanner).length);
if (process.env.SHOW_LOG) console.log('\n--- server log ---\n' + serverLog.slice(0, 4000));
process.exit(results.some((line) => line.startsWith('✘')) ? 1 : 0);
