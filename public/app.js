'use strict';
/* معلمي v2 — واجهة خفيفة: تخزين محدود + إعادة محاولة تلقائية + عرض مخنوق */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const uid = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

/* ---------- التخزين (محدود وآمن) ---------- */
const LS = { set: 'm2_settings', conv: 'm2_convs', exams: 'm2_exams' };
const store = {
  settings: { branch: '', key: '', endpoint: '', model: '' },
  convs: [], exams: [],
  load() {
    try { Object.assign(this.settings, JSON.parse(localStorage.getItem(LS.set) || '{}')); } catch {}
    try { this.convs = JSON.parse(localStorage.getItem(LS.conv) || '[]'); } catch {}
    try { this.exams = JSON.parse(localStorage.getItem(LS.exams) || '[]'); } catch {}
    if (!Array.isArray(this.convs)) this.convs = [];
  },
  save() {
    try {
      localStorage.setItem(LS.set, JSON.stringify(this.settings));
      // حدّ: 30 محادثة × 100 رسالة، بدون صور محفوظة (النص فقط)
      const slim = this.convs.slice(0, 30).map((c) => ({
        ...c, messages: (c.messages || []).slice(-100).map((m) => ({ role: m.role, content: m.content, cites: m.cites })),
      }));
      localStorage.setItem(LS.conv, JSON.stringify(slim));
      localStorage.setItem(LS.exams, JSON.stringify(this.exams.slice(0, 100)));
    } catch {
      // امتلاء التخزين: احتفظ بالأحدث فقط
      try {
        this.convs = this.convs.slice(0, 10);
        localStorage.setItem(LS.conv, JSON.stringify(this.convs));
      } catch {}
    }
  },
};
const headers = () => {
  const h = {};
  if (store.settings.key.trim()) h['X-AI-API-Key'] = store.settings.key.trim();
  if (store.settings.endpoint.trim()) h['X-AI-Endpoint'] = store.settings.endpoint.trim();
  if (store.settings.model.trim()) h['X-AI-Model'] = store.settings.model.trim();
  return h;
};

/* ---------- أدوات ---------- */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._x);
  t._x = setTimeout(() => t.classList.remove('show'), 2600);
}
function setStatus(mode, text) {
  const el = $('#status');
  el.className = 'status ' + (mode || '');
  el.querySelector('em').textContent = text;
}
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* markdown خفيف + كتلة quiz */
function md(src) {
  let html = esc(src);
  html = html.replace(/```quiz\s*([\s\S]*?)```/g, (_, j) => `@@QUIZ@@${esc(j.trim())}@@`);
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, l, c) => `<pre><code>${c.trim()}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h3>$1</h3>').replace(/^# (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = html.split('\n');
  let out = '', list = null;
  for (const ln of lines) {
    if (ln.startsWith('@@QUIZ@@')) { if (list) { out += list === 'ul' ? '</ul>' : '</ol>'; list = null; } out += ln; continue; }
    if (/^\s*[-*] /.test(ln)) { if (list !== 'ul') { if (list) out += '</ol>'; out += '<ul>'; list = 'ul'; } out += `<li>${ln.replace(/^\s*[-*] /, '')}</li>`; continue; }
    if (/^\s*\d+[.)] /.test(ln)) { if (list !== 'ol') { if (list) out += '</ul>'; out += '<ol>'; list = 'ol'; } out += `<li>${ln.replace(/^\s*\d+[.)] /, '')}</li>`; continue; }
    if (list) { out += list === 'ul' ? '</ul>' : '</ol>'; list = null; }
    if (/^<h3|^<pre|^@@/.test(ln)) out += ln;
    else if (ln.trim()) out += `<p>${ln}</p>`;
  }
  if (list) out += list === 'ul' ? '</ul>' : '</ol>';
  return out;
}
function quizCard(data) {
  try {
    const q = typeof data === 'string' ? JSON.parse(data) : data;
    if (!q || !Array.isArray(q.questions) || !q.questions.length) return null;
    const box = document.createElement('div');
    box.className = 'quiz';
    box.innerHTML = `<h3>${esc(q.title || 'اختبار قصير')}</h3><div class="muted small">${esc(q.subject || '')}</div>`;
    let score = 0, done = 0;
    const res = document.createElement('div');
    q.questions.slice(0, 10).forEach((it, i) => {
      const d = document.createElement('div');
      d.className = 'q';
      d.innerHTML = `<p>${i + 1}. ${esc(it.q || '')}</p>`;
      (it.options || []).slice(0, 6).forEach((op, oi) => {
        const b = document.createElement('button');
        b.textContent = op;
        b.onclick = () => {
          if (d.dataset.ok) return;
          d.dataset.ok = '1'; done++;
          const good = oi === Number(it.answer);
          if (good) { score++; b.classList.add('good'); } else { b.classList.add('bad'); d.querySelectorAll('button')[Number(it.answer)]?.classList.add('good'); }
          [...d.querySelectorAll('button')].forEach((x) => (x.disabled = true));
          const w = document.createElement('small');
          w.textContent = it.why || '';
          d.appendChild(w);
          if (done === Math.min(q.questions.length, 10)) {
            res.className = 'quiz-res';
            res.textContent = `نتيجتكِ ${score} من ${done} — أحسنتِ على المحاولة!`;
          }
        };
        d.appendChild(b);
      });
      box.appendChild(d);
    });
    box.appendChild(res);
    return box;
  } catch { return null; }
}

/* ---------- الشبكة: إعادة محاولة احترافية ---------- */
async function warmup() {
  setStatus('', 'جارٍ إيقاظ الخادم…');
  for (let i = 1; i <= 4; i++) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 12000);
      const r = await fetch('/api/health', { cache: 'no-store', signal: c.signal });
      clearTimeout(t);
      if (r.ok) { setStatus('ok', 'متصل — جاهز لسماعك'); return true; }
    } catch {}
    setStatus('', `إيقاظ الخادم… (محاولة ${i}/4)`);
    await new Promise((r) => setTimeout(r, 2500));
  }
  setStatus('bad', 'تعذر الوصول — تحققي من الإنترنت');
  return false;
}

async function* sseEvents(res, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k);
        buf = buf.slice(k + 2);
        let ev = 'message', data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (data) yield { ev, data: JSON.parse(data) };
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

async function streamOnce(payload, signal, onEvent) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error('TIMEOUT')), 100000);
  const link = () => { c.abort(signal?.reason); };
  signal?.addEventListener('abort', link, { once: true });
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', signal: signal?.aborted ? signal : c.signal,
      headers: { 'Content-Type': 'application/json', ...headers() },
      body: JSON.stringify(payload),
    });
    if (r.status === 501) throw new Error('NO_KEY');
    if (!r.ok) throw new Error('HTTP_' + r.status);
    for await (const { ev, data } of sseEvents(r, signal)) onEvent(ev, data);
  } finally { clearTimeout(t); signal?.removeEventListener('abort', link); }
}

/* ---------- المحادثة ---------- */
let cur = null; // المحادثة الحالية
let running = null; // {abort}
let pendingImages = [];

function getConv() {
  let c = store.convs.find((x) => x.id === cur);
  if (!c) { c = { id: uid('c'), title: 'محادثة جديدة', at: Date.now(), messages: [] }; store.convs.unshift(c); cur = c.id; }
  return c;
}
function apiMessages(conv) {
  return conv.messages.filter((m) => m.content).map((m) => ({ role: m.role, content: m.content }));
}

function scrollBottom(force) {
  const m = $('#msgs');
  if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 220) m.scrollTop = m.scrollHeight;
}

function addUser(text) {
  const d = document.createElement('div');
  d.className = 'msg u';
  d.innerHTML = `<div class="bubble"><p>${esc(text).replace(/\n/g, '<br>')}</p></div>`;
  $('#msgs').appendChild(d);
  scrollBottom(true);
}

function assistantShell() {
  const d = document.createElement('div');
  d.className = 'msg a';
  d.innerHTML = `<div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div><div class="srcs"></div>`;
  $('#msgs').appendChild(d);
  scrollBottom(true);
  return d;
}

function finalizeAssistant(shell, text, cites) {
  const bub = shell.querySelector('.bubble');
  const parts = String(text).split(/@@QUIZ@@([\s\S]*?)@@/g);
  bub.innerHTML = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) { const card = quizCard(part); if (card) bub.appendChild(card); }
    else if (part.trim()) { const t = document.createElement('div'); t.innerHTML = md(part); bub.appendChild(t); }
  });
  if (cites?.length) {
    const s = shell.querySelector('.srcs');
    s.innerHTML = '';
    cites.forEach((c) => {
      const el = document.createElement('span');
      el.className = 'src';
      el.textContent = `▦ ${c.title}${c.printed ? ' · ص' + c.printed : ''}`;
      s.appendChild(el);
    });
    $('#srcLine').textContent = `المصادر: ${cites.map((c) => c.title + (c.printed ? ' ص' + c.printed : '')).join('، ')}`;
  }
}

function errorCard(shell, msg, retryFn) {
  const bub = shell.querySelector('.bubble');
  bub.innerHTML = `<div class="err">⚠ ${esc(msg)}<br><button class="btn primary" style="margin-top:8px">إعادة المحاولة</button></div>`;
  bub.querySelector('button').onclick = retryFn;
}

const errText = (e) => {
  const m = String(e?.message || e);
  if (m.includes('NO_KEY')) return 'لا يوجد مفتاح. أضيفيه من الإعدادات ⚙ أو استخدمي إعدادات الخادم.';
  if (m.includes('TIMEOUT')) return 'استغرق الرد وقتًا طويلًا. أعيدي المحاولة.';
  if (m.includes('UPSTREAM_AUTH')) return 'المفتاح مرفوض من المزود. تحققي من المفتاح في الإعدادات ⚙.';
  if (m.includes('UPSTREAM_MODEL')) return 'اسم النموذج غير مدعوم. غيّريه من الإعدادات ⚙.';
  if (m.includes('UPSTREAM_BAD_REQUEST')) return 'الطلب مرفوض من المزود. جرّبي تقليل النص أو الصور.';
  if (m.includes('UPSTREAM_BUSY') || m.includes('429')) return 'الضغط عالٍ على المزود الآن. سأعيد المحاولة تلقائيًا…';
  if (m.includes('UPSTREAM')) return 'تعذر الوصول للمزود. أعيد المحاولة…';
  if (!navigator.onLine) return 'انقطع الإنترنت. سأكمل تلقائيًا عند عودته.';
  return 'انقطع الاتصال أثناء الرد. أعيد المحاولة…';
};

async function send(text, images, attempt = 1) {
  if (running) return;
  const conv = getConv();
  const payload = { messages: [...apiMessages(conv), { role: 'user', content: text }], branch: store.settings.branch };
  if (images?.length) payload.messages[payload.messages.length - 1] = { role: 'user', content: [{ type: 'text', text }, ...images] };

  addUser(text);
  conv.messages.push({ role: 'user', content: text });
  $('#chatTitle').textContent = conv.title === 'محادثة جديدة' && text ? text.slice(0, 40) : conv.title;
  if (conv.title === 'محادثة جديدة' && text) conv.title = text.replace(/\s+/g, ' ').slice(0, 48);
  store.save(); renderSideHistory();

  const shell = assistantShell();
  const abort = new AbortController();
  running = { abort };
  $('#sendBtn').hidden = true; $('#stopBtn').hidden = false;
  setStatus('ok', attempt > 1 ? `أعيد المحاولة (${attempt}/3)…` : 'المعلم يكتب…');

  let full = '', cites = [], done = false, failed = null;
  let raf = 0;
  const paint = () => {
    raf = 0;
    shell.querySelector('.bubble').innerHTML = md(full) + '<span class="typing"><i></i><i></i><i></i></span>';
    scrollBottom(false);
  };
  try {
    await streamOnce(payload, abort.signal, (ev, data) => {
      if (ev === 'citations') cites = data.items || [];
      else if (ev === 'delta') { full += data.text || ''; if (!raf) raf = requestAnimationFrame(paint); }
      else if (ev === 'done') done = true;
      else if (ev === 'error') throw new Error(data.error || 'UPSTREAM_FAILED');
    });
    if (raf) cancelAnimationFrame(raf);
    if (!done && !full) throw new Error('EMPTY_REPLY');
    conv.messages.push({ role: 'assistant', content: full, cites });
    finalizeAssistant(shell, full, cites);
  } catch (e) {
    if (raf) cancelAnimationFrame(raf);
    if (e?.name === 'AbortError' || abort.signal.aborted) {
      if (full) { conv.messages.push({ role: 'assistant', content: full + '\n\n(أُوقف الرد هنا)', cites }); finalizeAssistant(shell, full, cites); }
      else shell.remove();
    } else {
      failed = e;
      if (attempt < 3) {
        setStatus('', `انقطع الاتصال — أعيد المحاولة (${attempt + 1}/3)…`);
        shell.querySelector('.bubble').innerHTML = `<span class="typing"><i></i><i></i><i></i></span> <small class="muted">أعيد المحاولة تلقائيًا…</small>`;
        running = null;
        $('#sendBtn').hidden = false; $('#stopBtn').hidden = true;
        conv.messages.pop(); // إزالة رسالة المستخدم المؤقتة لإعادة إرسالها نظيفة
        shell.remove();
        if (!navigator.onLine) await new Promise((r) => { const f = () => { window.removeEventListener('online', f); r(); }; window.addEventListener('online', f); setTimeout(r, 20000); });
        else await new Promise((r) => setTimeout(r, 1200 * attempt));
        $('#msgs').querySelector('.msg.u:last-child')?.remove?.();
        return send(text, images, attempt + 1);
      }
      errorCard(shell, errText(e), () => { shell.remove(); conv.messages.pop(); store.save(); send(text, images, 1); });
    }
  } finally {
    running = null;
    $('#sendBtn').hidden = false; $('#stopBtn').hidden = true;
    setStatus('ok', 'متصل — جاهز لسماعك');
    store.save();
  }
  void failed;
}

/* ---------- الصور ---------- */
function compress(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onerror = () => rej(new Error('IMG'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => rej(new Error('IMG'));
      img.onload = () => {
        const k = Math.min(1, 1024 / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/jpeg', 0.72));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
function paintPrev() {
  const p = $('#imgPrev');
  p.innerHTML = '';
  p.hidden = !pendingImages.length;
  pendingImages.forEach((s, i) => {
    const im = document.createElement('img');
    im.src = s; im.alt = 'مرفق';
    im.onclick = () => { pendingImages.splice(i, 1); paintPrev(); };
    p.appendChild(im);
  });
}

/* ---------- العرض ---------- */
function renderConv() {
  const conv = getConv();
  $('#msgs').innerHTML = '';
  $('#chatTitle').textContent = conv.title;
  $('#srcLine').textContent = '';
  if (!conv.messages.length) {
    $('#msgs').innerHTML = `<div class="msg a"><div class="bubble"><h3>من أين نبدأ يا رحما؟</h3><p>اكتبي سؤالًا، أو اذكري رقم الصفحة والكتاب — مثلًا: <b>اشرح صفحة 6 من كتاب التربية الإسلامية</b>.</p></div></div>`;
    return;
  }
  for (const m of conv.messages) {
    if (m.role === 'user') addUser(m.content);
    else { const s = assistantShell(); s.querySelector('.typing')?.remove(); finalizeAssistant(s, m.content, m.cites); }
  }
  scrollBottom(true);
}
function renderSideHistory() {
  const box = $('#sideHistory');
  box.innerHTML = '';
  store.convs.slice(0, 20).forEach((c) => {
    const b = document.createElement('button');
    b.className = 'side-h' + (c.id === cur ? ' on' : '');
    b.textContent = c.title;
    b.onclick = () => { cur = c.id; renderConv(); renderSideHistory(); showView('chat'); };
    box.appendChild(b);
  });
}
function renderHistoryView() {
  const q = ($('#hSearch').value || '').toLowerCase();
  const list = $('#hList');
  list.innerHTML = '';
  store.convs.filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => (m.content || '').toLowerCase().includes(q))).forEach((c) => {
    const d = document.createElement('div');
    d.className = 'h-item';
    d.innerHTML = `<div><b>${esc(c.title)}</b><br><small>${c.messages.filter((m) => m.role === 'user').length} رسائل</small></div>`;
    const del = document.createElement('button');
    del.textContent = '×'; del.setAttribute('aria-label', 'حذف');
    del.onclick = (e) => { e.stopPropagation(); if (confirm('حذف هذه المحادثة؟')) { store.convs = store.convs.filter((x) => x.id !== c.id); if (cur === c.id) cur = null; store.save(); renderHistoryView(); renderSideHistory(); renderConv(); } };
    d.appendChild(del);
    d.onclick = () => { cur = c.id; renderConv(); renderSideHistory(); showView('chat'); };
    list.appendChild(d);
  });
}
function renderExams() {
  const list = $('#examList');
  list.innerHTML = '';
  const today = new Date().toISOString().slice(0, 10);
  store.exams.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).forEach((e) => {
    const days = Math.ceil((new Date(e.date) - new Date(today)) / 86400000);
    const d = document.createElement('div');
    d.className = 'exam';
    d.innerHTML = `<div><b>${esc(e.title)}</b><br><small>${e.date}</small></div><b class="${days <= 3 ? 'soon' : ''}">${days === 0 ? 'اليوم' : days === 1 ? 'غدًا' : 'بعد ' + days + ' يوم'}</b>`;
    const del = document.createElement('button');
    del.textContent = '×';
    del.onclick = () => { store.exams = store.exams.filter((x) => x.id !== e.id); store.save(); renderExams(); };
    d.appendChild(del);
    list.appendChild(d);
  });
}
function showView(v) {
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.v === v));
  $('#v-chat').hidden = v !== 'chat';
  $('#v-history').hidden = v !== 'history';
  $('#v-exams').hidden = v !== 'exams';
  if (v === 'history') renderHistoryView();
  if (v === 'exams') renderExams();
}

/* ---------- الإقلاع ---------- */
function boot() {
  store.load();
  // الترحيب
  let sel = store.settings.branch || '';
  const paintSel = () => $$('.branch').forEach((b) => b.classList.toggle('sel', b.dataset.b === sel));
  $$('.branch').forEach((b) => (b.onclick = () => { sel = b.dataset.b; paintSel(); $('#startBtn').disabled = false; }));
  paintSel();
  $('#startBtn').disabled = !sel;
  $('#startBtn').onclick = () => { store.settings.branch = sel; store.save(); enter(); };
  if (store.settings.branch) enter(); else { $('#welcome').hidden = false; }

  // الأحداث
  const input = $('#input');
  const go = () => {
    const t = input.value.trim();
    const imgs = pendingImages.map((url) => ({ type: 'image_url', image_url: { url } }));
    if ((!t && !imgs.length) || running) return;
    input.value = ''; input.style.height = 'auto';
    pendingImages = []; paintPrev();
    send(t || 'اشرحي ما يظهر في الصور المرفقة.', imgs.length ? imgs : null);
  };
  $('#sendBtn').onclick = go;
  $('#stopBtn').onclick = () => running?.abort.abort(new DOMException('stop', 'AbortError'));
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } });
  $('#attachBtn').onclick = () => $('#imgInput').click();
  $('#imgInput').onchange = async (e) => {
    for (const f of [...e.target.files].slice(0, 2 - pendingImages.length)) {
      try { pendingImages.push(await compress(f)); } catch { toast('تعذرت قراءة صورة'); }
    }
    e.target.value = '';
    paintPrev();
  };
  $$('.hints button').forEach((b) => (b.onclick = () => { input.value = b.dataset.q; input.focus(); }));
  $$('.tab').forEach((t) => (t.onclick = () => showView(t.dataset.v)));
  const fresh = () => { cur = null; store.save(); renderConv(); renderSideHistory(); showView('chat'); };
  $('#newChatBtn').onclick = fresh; $('#newChatSide').onclick = fresh;
  $('#hSearch').addEventListener('input', renderHistoryView);
  $('#examForm').onsubmit = (e) => {
    e.preventDefault();
    const title = $('#examTitle').value.trim(), date = $('#examDate').value;
    if (!title || !date) return;
    store.exams.push({ id: uid('e'), title, date });
    store.save(); renderExams();
    $('#examTitle').value = ''; $('#examDate').value = '';
    toast('أُضيف الموعد ✓');
  };
  // الإعدادات
  $('#settingsBtn').onclick = () => {
    $('#setBranch').value = store.settings.branch || '';
    $('#setKey').value = store.settings.key || '';
    $('#setEndpoint').value = store.settings.endpoint || '';
    $('#setModel').value = store.settings.model || '';
    $('#settings').hidden = false;
  };
  $('#setClose').onclick = () => ($('#settings').hidden = true);
  $('#settings').addEventListener('click', (e) => { if (e.target.id === 'settings') $('#settings').hidden = true; });
  $('#setSave').onclick = () => {
    const ep = $('#setEndpoint').value.trim();
    if (ep && !/^https:\/\//.test(ep) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(ep)) { toast('الرابط يجب أن يبدأ بـ https'); return; }
    store.settings.branch = $('#setBranch').value;
    store.settings.key = $('#setKey').value.trim();
    store.settings.endpoint = ep;
    store.settings.model = $('#setModel').value.trim();
    store.save();
    $('#branchPill').textContent = store.settings.branch ? 'الفرع ' + store.settings.branch : '';
    $('#settings').hidden = true;
    toast('حُفظت الإعدادات ✓');
    warmup();
  };
  $('#testConn').onclick = async () => {
    $('#testRes').textContent = 'أختبر…';
    const ok = await warmup();
    try {
      const r = await fetch('/api/config', { headers: headers() });
      const j = await r.json();
      $('#testRes').textContent = ok ? (j.hasKey ? `متصل ✓ (${j.model})` : 'الخادم يعمل لكن لا يوجد مفتاح') : 'تعذر الاتصال';
    } catch { $('#testRes').textContent = 'تعذر الاتصال'; }
  };
  // الشبكة
  window.addEventListener('offline', () => ($('#offlineBar').hidden = false));
  window.addEventListener('online', () => { $('#offlineBar').hidden = true; warmup(); });
  if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) navigator.serviceWorker.register('/sw.js').catch(() => {});
  warmup();
}

function enter() {
  $('#welcome').hidden = true;
  $('#app').hidden = false;
  $('#branchPill').textContent = store.settings.branch ? 'الفرع ' + store.settings.branch : '';
  renderConv(); renderSideHistory();
}

document.addEventListener('DOMContentLoaded', boot);
