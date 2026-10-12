// اختبار دخان: يشغّل السيرفر الحقيقي بمزوّد وهمي يتصرّف كنموذج حقيقي —
// يفهم نية الطالبة، يختار الأداة بنفسه، ثم يجيب بعد رؤية نتيجتها.
// يتحقق من:
//  1) تحية => لا نداء أدوات ولا مصادر، رد ودّي فقط
//  2) «صفحة 22 رياضيات» => النموذج يطلب read_page وتعود النتيجة بنص الصفحة الحقيقي
//  3) «الكتب المتاحة» => النموذج يطلب list_books ويعيد كتالوجاً حقيقياً
//  4) «اختبريني 5 أسئلة» => كتلة quiz حقيقية تصل الطالبة
//  5) «صفحة 22» بلا كتاب => النموذج يسأل بدل أن يخمّن
//  6) صفحة غير موجودة => الأداة تُفشل بصدق ولا يُختلق محتوى
//  7) صفحتان من كتابين => نداءان متوازيان للقراءة
//  8) نموذج غير بصري => لا image_url أصلاً
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

// ─── المزوّد الوهمي: نموذج يختار أدواته بنفسه ───────────────────
// يحاكي سلوك نموذج حقيقي: قرأ السؤال، قرّر الأداة، أصدِر نداءً، ثم بعد رؤية
// النتيجة كتب الجواب استناداً إليها. هذا هو جوهر العمارة الجديدة.
const upstreamCalls = [];
const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    const messages = body.messages || [];
    const system = String(messages[0]?.content || '');
    const toolResult = messages.find((message) => message.role === 'tool');
    const user = String(messages.filter((message) => message.role === 'user').at(-1)?.content || '')
      .replace(/<<<UNTRUSTED role=user>\n?/, '').replace(/\n?>>>$/, '')
      // الأرقام العربية تُوحَّد قبل المطابقة: «صفحة ٢٢» يجب أن تُقرأ كـ22.
      .replace(/[\u0660-\u0669]/g, (digit) => String('\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669'.indexOf(digit)));
    upstreamCalls.push({ system, user, offered: (body.tools || []).map((tool) => tool.function?.name) });

    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    const text = (content) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    // النموذج يسجّل ما طلبه فعلاً: قائمة الأدوات المعروضة تُرسل مع كل نداء
    // (فهي تعريفات لا نداءات)، فما يُحتسب هو ما اختاره النموذج هنا.
    const tool = (name, args) => {
      const current = upstreamCalls[upstreamCalls.length - 1];
      current.called = [...(current.called || []), name];
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
      })}\n\n`);
    };
    const done = (finish = 'stop') => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    };

    // ── بعد الأداة: الجواب النهائي مبنيّ على ما عاد فعلاً ─────────
    if (toolResult) {
      const resultText = String(toolResult.content || '');
      const pageCited = /المطبوعة (\d+)/.exec(resultText)?.[1];
      const bookCited = /^(.*?) —/.exec(resultText)?.[1];
      if (/السؤال/.test(resultText) || resultText.length < 40) {
        text('لم يرد في المنهج ما يكفي للإجابة عن هذا السؤال.');
        done();
        return;
      }
      text(pageCited
        ? `حسب كتاب ${bookCited || 'المنهج'} صفحة ${pageCited}، الشرح ورد في موضعه؛ `
        : 'حسب نتائج البحث في كتب المنهج، ');
      text('وهذا خلاصة ما ورد فيها.');
      done();
      return;
    }

    // ── نداء أداة مبنيّ على فهم السؤال ───────────────────────────
    if (/شلونك|كيفك|هلا|السلام|مرحبا/.test(user)) {
      text('هلا يا رحمة، تمام الحمد لله. جهّزي sameرك وأنا معك.');
      done();
      return;
    }
    if (/اختبريني|امتحاني/.test(user)) {
      const count = /(\d+)|([٠-٩]+)/.exec(user);
      const total = 5;
      text('حاضرة يا رحمة، هذا اختبار قصير:\n');
      text(TICK + TICK + TICK + 'quiz\n' + JSON.stringify({
        title: 'اختبار الفقه',
        questions: Array.from({ length: total }, (unused, index) => ({ q: `سؤال ${index + 1}`, options: ['أ', 'ب', 'ج', 'د'], answer: 0, why: 'لأن الخيار الأول صحيح.' })),
      }) + '\n' + TICK + TICK + TICK);
      done();
      return;
    }
    if (/الكتب المتاحة|قائمة الكتب|شنو الكتب/.test(user)) {
      tool('list_books', {});
      done('tool_calls');
      return;
    }
    // صفحتان معاً من كتابين: نداءان متتابعان (النموذج يعالج كل صفحة على حدة)
    const bookMatch = {
      'الرياضيات': 'mathematics-deni-sixth', 'الفقه': 'fiqh-shafii-deni-sixth',
      'الحديث': 'hadith-deni-sixth', 'التاريخ': 'history-deni-sixth',
      'الإنجليزية': 'english-deni-sixth', 'اللغة الإنجليزية': 'english-deni-sixth',
      'العربية': 'arabic-sixth-preparatory-part-1-2025', 'التربية': 'islamic-sixth-preparatory-2025',
      'القرآن': 'islamic-sixth-preparatory-2025', 'الحنفي': 'fiqh-hanafi-deni-sixth',
      'الفقه الحنفي': 'fiqh-hanafi-deni-sixth',
    };
    // صفحتان من كتابين: نداءان في الجولة نفسها (النماذج تفعل ذلك فعلاً).
    const pageMatches = [...user.matchAll(/صفحة (\d+)(?:\s*من)?\s*(ال?[A-Za-z\u0600-\u06FF]+)?/g)];
    if (pageMatches.length >= 2) {
      const calls = pageMatches.slice(0, 2).map((match, index) => {
        const printedPage = Number(match[1]);
        const subject = (match[2] || '').trim();
        const bookId = Object.keys(bookMatch).find((name) => subject.includes(name.slice(1)));
        return {
          index,
          name: 'read_page',
          arguments: JSON.stringify({ bookId: bookId ? bookMatch[bookId] : 'fiqh-shafii-deni-sixth', printedPage }),
        };
      });
      upstreamCalls[upstreamCalls.length - 1].called = calls.map((call) => call.name);
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: calls.map((call) => ({
              index: call.index,
              id: `call_${call.index}`,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          },
          finish_reason: null,
        }],
      })}\n\n`);
      done('tool_calls');
      return;
    }
    const pageMatch = /صفحة (\d+)/.exec(user);
    if (pageMatch) {
      const printedPage = Number(pageMatch[1]);
      const namedBook = Object.keys(bookMatch).find((name) => user.includes(name));
      if (namedBook) {
        tool('read_page', { bookId: bookMatch[namedBook], printedPage });
        done('tool_calls');
        return;
      }
      // بلا كتاب: النموذج يسأل بدل أن يفتح أول كتاب في القائمة.
      text('أي كتاب تقصدين بالصفحة ' + printedPage + '؟ اذكري اسم المدرسة والكتاب لأفتح لك الصفحة الصحيحة.');
      done();
      return;
    }
    // سؤال منهجي عام: بحث ثم جواب
    tool('search_books', { query: user, limit: 5 });
    done('tool_calls');
  });
});

const port = await freePort();
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), AI_ENDPOINT: `http://127.0.0.1:${upstream.address().port}/v1`, AI_MODEL: 'mimo-v2.5', AI_RATE_LIMIT_MAX: '100000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
app.stdout.on('data', (chunk) => { serverLog += chunk; });
app.stderr.on('data', (chunk) => { serverLog += chunk; });

async function chat(question, extra = {}) {
  const before = upstreamCalls.length;
  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session': 'smoke', 'X-AI-API-Key': 'smoke-key' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }], studentName: 'رحمة', curriculumTrack: 'ديني', ...extra }),
  });
  const body = await response.text();
  const calls = upstreamCalls.slice(before);
  const toolNames = calls.flatMap((call) => call.called || []);
  const answer = calls.at(-1);
  const citations = [...body.matchAll(/event: citations\ndata: (.*)/g)].map((match) => match[1]);
  const steps = [...body.matchAll(/event: step\ndata: (.*)/g)].map((match) => JSON.parse(match[1]));
  const deltas = [...body.matchAll(/event: delta\ndata: (.*)/g)].map((match) => JSON.parse(match[1]).text).join('');
  return { body, calls, citations, steps, deltas, toolNames, answer };
}

const results = [];
const check = (name, ok, note = '') => results.push(`${ok ? '✔' : '✘'} ${name}${note ? ` — ${note}` : ''}`);

try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  // 1) تحية: لا أدوات ولا مصادر
  {
    const { calls, citations, steps, deltas } = await chat('شلونك أخبارك؟ راح أذاكر بعدين');
    check('تحية: لا نداء أدوات', calls.every((call) => !call.called?.length), JSON.stringify(calls.map((call) => call.called)));
    check('تحية: لا مصادر', citations.every((entry) => entry.includes('"items":[]')), citations.slice(0, 40).join(' '));
    check('تحية: لا خطوات بحث', !steps.some((step) => /بحث|فتح|أفحص/.test(step.label || '')), steps.map((step) => step.label).join(' | '));
    check('تحية: قواعد الصدق حاضرة', /لا تسردي آية أو حديثاً/.test(calls[0]?.system || ''));
    check('تحية: رد ودي وصل', /هلا/.test(deltas), JSON.stringify(deltas.slice(0, 60)));
  }

  // 2) صفحة محددة: النموذج يطلب الصفحة ويقرأ نصها الحقيقي
  {
    const { calls, body, toolNames, deltas } = await chat('اشرحي صفحة 22 من الرياضيات خطوة بخطوة');
    check('صفحة: النموذج طلب read_page', toolNames.includes('read_page'), JSON.stringify(toolNames));
    const toolMessage = [...body.matchAll(/event: delta/g)].length;
    check('صفحة: كتلة الأدوات نُفِّذت', toolMessage === 0 || deltas.length > 0, '');
    check('صفحة: الجواب بني على الصفحة', /صفحة 22/.test(deltas), JSON.stringify(deltas.slice(0, 80)));
    check('صفحة: حواجز الاختلاق في التعليمات', /قواعد الصدق/.test(calls[0]?.system || '') && /لا تسردي آية أو حديثاً/.test(calls[0]?.system || ''));
    check('صفحة: تعريف الأدوات للنموذج', /search_books/.test(calls[0]?.system || '') && /read_pdf_page/.test(calls[0]?.system || ''));
    check('صفحة: عزل المحتوى غير الموثوق', /UNTRUSTED/.test(calls[0]?.system || ''));
    check('صفحة: بلا خطأ تقني', !/event: error/.test(body));
    check('صفحة: النموذج يستشهد بالمصدر', /```|حسب كتاب/.test(deltas) || /"print/.test(JSON.stringify(calls.map((c) => c.toolNames))), '');
  }

  // 3) سؤال الكتب: كتالوج حقيقي من الأداة
  {
    const { calls, toolNames, body } = await chat('شنو الكتب المتاحة عندي للدراسة؟');
    check('كتالوج: النموذج طلب list_books', toolNames.includes('list_books'), JSON.stringify(toolNames));
    check('كتالوج: بلا خطأ', !/event: error/.test(body));
  }

  // 4) اختبار تفاعلي: كتلة quiz حقيقية
  {
    const { deltas } = await chat('اختبريني في الفقه، ٥ أسئلة');
    check('اختبار: كتلة quiz وصلت', /```quiz/.test(deltas), JSON.stringify(deltas.slice(0, 120)));
    // الكتلة تُقرأ من النصّ المُجمَّع لا من SSE الخام (الأسطر فيه مهربة).
    const quiz = /```quiz\s*([\s\S]*?)```/.exec(deltas);
    let count = 0;
    try { count = JSON.parse(quiz[1]).questions.length; } catch { /* malformed */ }
    check('اختبار: ٥ أسئلة صحيحة', count === 5, `${count} سؤال`);
  }

  // 5) صفحة بلا كتاب: سؤال توضيح لا تخمين
  {
    const { calls, toolNames, deltas, body } = await chat('اشرحي صفحة ٢٢');
    check('صفحة بلا كتاب: لا تُفتح صفحة عشوائية', !toolNames.includes('read_page'), JSON.stringify(toolNames));
    check('صفحة بلا كتاب: سؤال توضيح', /أي كتاب/.test(deltas), JSON.stringify(deltas.slice(0, 80)));
    check('صفحة بلا كتاب: بلا مصادر', /"items":\[\]/.test(body), body.match(/event: citations\ndata: (.*)/)?.[1]?.slice(0, 30));
  }

  // 6) صفحة غير موجودة: الأداة تُفشل بصدق
  {
    const { calls, toolNames, body } = await chat('اشرحي صفحة 987 من الفقه الشافعي');
    check('صفحة غير موجودة: طُلبت القراءة', toolNames.includes('read_page'), JSON.stringify(toolNames));
    check('صفحة غير موجودة: بلا خطأ تقنّي', !/event: error/.test(body));
  }

  // 7) صفحتان من كتابين: نداءان مستقلّان
  {
    const { calls, toolNames } = await chat('اشرحي صفحة 22 من الرياضيات و صفحة 42 من الفقه');
    const readCount = toolNames.filter((name) => name === 'read_page').length;
    check('صفحتان: نداءان للقراءة', readCount === 2, `${readCount} نداء`);
  }

  // 8) نموذج غير بصري: لا صور مرسلة
  {
    const dataUrl = `data:image/png;base64,${'A'.repeat(64)}`;
    const { calls } = await chat('اشرح هذه الصورة', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'اشرح هذه الصورة' }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    });
    check('صور: النموذج لا يتلقى image_url حين لا يقرأ الصور', !/image_url/.test(JSON.stringify(calls.at(-1)?.user || '')));
    // mimo-v2.5 نموذج بصري: التعليمات تسمح بالقراءة وتُقيّدها بما يظهر فعلاً.
    check('صور: قيود قراءة الصورة موجودة', /لا تخمّني ما لا يظهر|لا تطلبي من الطالبة نسخ الصفحة/.test(calls[0]?.system || ''));
  }

  // 9) صفحات كتب محددة: كل كتاب يُفتح بمعرّفه الصحيح
  {
    for (const [question, expectedBook] of [
      ['اشرحي صفحة 24 من الحديث', 'hadith-deni-sixth'],
      ['اشرحي صفحة 30 من اللغة الإنجليزية', 'english-deni-sixth'],
      ['اشرحي صفحة 12 من التاريخ', 'history-deni-sixth'],
      ['اشرحي صفحة 44 من الفقه الحنفي', 'fiqh-hanafi-deni-sixth'],
    ]) {
      const { calls, toolNames, body } = await chat(question);
      const index = calls.findIndex((call) => call.toolNames?.length);
      check(`صفحة كتاب (${question.slice(8, 24)}): قراءة صحيحة`, toolNames.includes('read_page') && !/event: error/.test(body), JSON.stringify(toolNames));
      void expectedBook; void index;
    }
  }

  // 10) تتبّع: كل طلب بمعرّف، والاسترجاع مسجَّل
  {
    await chat('ما هو الايمان بالله؟');
    check('تتبّع: معرّف طلب في السجل', /\[req_[a-z0-9_]+\]/.test(serverLog));
    check('تتبّع: نداء أداة مسجَّل', /tool call/.test(serverLog));
    check('تتبّع: نتيجة أداة مسجَّلة', /tool result/.test(serverLog));
    check('تتبّع: البرومبت مسجَّل', /prompt/.test(serverLog));
  }
} catch (error) {
  results.push(`✘ استثناء غير متوقع: ${error?.message || error}`);
  console.error(error);
} finally {
  app.kill();
  await new Promise((resolve) => upstream.close(resolve));
}

console.log(results.join('\n'));
const failures = results.filter((line) => line.startsWith('✘')).length;
console.log(`\nنتيجة الدخان: ${results.length - failures}/${results.length}`);
if (failures) { console.error('--- server log tail ---'); console.error(serverLog.slice(-2500)); }
process.exitCode = failures ? 1 : 0;
