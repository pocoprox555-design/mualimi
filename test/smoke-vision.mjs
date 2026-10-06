// فحص Vision: يشغّل السيرفر بنموذج يدعم الرؤية ويتحقق أن الصورة تُرسل فعلاً
// وأن تعليمات القراءة البصرية موجودة، وأن صفحة مصوّرة تُفتح. هذا المسار لا
// يعمل على النشر الحالي (mimo بلا vision) فلا يغطيه أي فحص آخر.
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, note = '') => results.push(`${ok ? '✔' : '✘'} ${name}${note ? ` — ${note}` : ''}`);

const calls = [];
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    const system = String(body.messages?.[0]?.content || '');
    const last = body.messages?.at(-1)?.content;
    calls.push({ system, last });
    const reply = /مخطط استعمال أدوات/.test(system)
      ? '{"intent":"curriculum","use_local":true}'
      : 'قرأتُ ما في الصورة وسأشرحه.';
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

const port = await new Promise((resolve) => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1', () => { const { port: value } = probe.address(); probe.close(() => resolve(value)); });
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), AI_API_KEY: 'vision-key', AI_ENDPOINT: `http://127.0.0.1:${upstream.address().port}/v1`, AI_MODEL: 'deepseek-v4-flash-vision-exp' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
app.stdout.on('data', (chunk) => { log += chunk; });
app.stderr.on('data', (chunk) => { log += chunk; });

async function chat(question, extra = {}) {
  const before = calls.length;
  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session': 'vision', 'X-AI-API-Key': 'vision-key' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }], studentName: 'رحمة', curriculumTrack: 'ديني', ...extra }),
  });
  const body = await response.text();
  return { body, calls: calls.slice(before) };
}

try {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  check('config: النموذج البصري مُعلن supportsVision=true', config.supportsVision === true, `model=${config.model}`);

  const dataUrl = `data:image/png;base64,${'A'.repeat(64)}`;
  {
    const { calls: turn } = await chat('اشرح ما في هذه الصورة', { messages: [{ role: 'user', content: [{ type: 'text', text: 'اشرح ما في هذه الصورة' }, { type: 'image_url', image_url: { url: dataUrl } }] }] });
    const answer = turn.findLast((call) => !/مخطط استعمال أدوات/.test(call.system));
    const hasImage = Array.isArray(answer?.last) && answer.last.some((part) => part?.type === 'image_url');
    check('صورة مرفوعة: تُرسل image_url مع النموذج البصري', hasImage, JSON.stringify(answer?.last)?.slice(0, 80));
    check('صورة مرفوعة: تعليمات القراءة البصرية موجودة', /صورة صفحة مرفقة|صورة صفحة للقراءة البصرية/.test(answer?.system || ''));
    check('صورة مرفوعة: لا تطلب كتابة النص', !/لا تُظهره كاملاً[\s\S]{0,80}الصورة/.test(answer?.system || '') && !/اكتبي نص الصورة/.test(answer?.system || ''));
  }

  {
    const { body, calls: turn } = await chat('اشرحي صفحة 24 من التربية الإسلامية');
    const answer = turn.findLast((call) => !/مخطط استعمال أدوات/.test(call.system));
    const system = answer?.system || '';
    const pageSection = (system.split('## مصادر الصفحات')[1] || '').split('\n\n## ')[0];
    // صفحة 24 من التربية الإسلامية نصها مستخرج مختل/مفقود. إمّا فُتحت صورتها
    // وأُرسلت بصرياً، وإمّا دخلت بوابة الامتناع. الحالة الثالثة (شرح من كتاب
    // آخر) ممنوعة منعاً باتاً.
    const visualRead = /صورة صفحة PDF|صورة صفحة مرفقة|صورة صفحة للقراءة البصرية/.test(system);
    const gate = /لم تصل بدليل موثوق|توضيح مطلوب|دليل الصفحة غير حرفي|النسخة الرقمية لم تُظهر/.test(system);
    const otherBook = /(?:تاريخ|قواعد|النحو|حديث|قراءات)[^|\n]{0,40}\|\s*الصفحة المطبوعة/.test(pageSection);
    check('صفحة بلا نص (التربية 24): دليل بصري أو بوابة امتناع، لا كتاب آخر', visualRead || gate, `بصري=${visualRead} · بوابة=${gate} · كتل=${pageSection.length}`);
    check('صفحة بلا نص: لا صفحة من كتاب آخر في السياق', !otherBook);
    check('صفحة بلا نص: لا خطأ VISION_NOT_SUPPORTED', !/VISION_NOT_SUPPORTED/.test(body));
  }
} catch (error) {
  results.push(`✘ استثناء: ${error?.message || error}`);
} finally {
  app.kill();
  await new Promise((resolve) => upstream.close(resolve));
}

console.log(results.join('\n'));
if (process.env.SHOW_LOG) console.log('\n--- log ---\n' + log.slice(0, 2500));
process.exit(results.some((line) => line.startsWith('✘')) ? 1 : 0);
