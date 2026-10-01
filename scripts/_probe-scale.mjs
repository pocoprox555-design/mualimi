import { readFile } from 'node:fs/promises';

const auth = JSON.parse(await readFile('C:/Users/m/.local/share/opencode/auth.json', 'utf8'));
const key = Object.values(auth)[0].key;
const url = 'https://opencode.ai/zen/go/v1/chat/completions';
const dir = 'C:/Users/m/AppData/Local/Temp/opencode/ocr-test';
const prompt = 'انسخ النص العربي الموجود في هذه الصورة حرفًا بحرف مع الحفاظ على التشكيل، دون أي كلام آخر.';

async function call(label, file) {
  const image = await readFile(`${dir}/${file}`);
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'x-opencode-session': `scale-test-${Date.now()}-${label}` },
    body: JSON.stringify({
      model: 'mimo-v2.6-flash',
      stream: false,
      temperature: 0.1,
      max_tokens: 6000,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } },
      ] }],
    }),
  });
  const json = await response.json();
  const usage = json.usage || {};
  console.log(label, response.status, `${((Date.now() - started) / 1000).toFixed(1)}s`,
    'prompt=' + usage.prompt_tokens, 'reasoning=' + usage.completion_tokens_details?.reasoning_tokens,
    'out=' + String(json.choices?.[0]?.message?.content || '').length);
}

const single1 = Date.now();
await call('scale2-single', 't7s2.png');
console.log(`  wall1=${((Date.now() - single1) / 1000).toFixed(1)}s`);

const parallelStart = Date.now();
await Promise.all([
  call('p-a', 't7s12.png'),
  call('p-b', 't7s12.png'),
  call('p-c', 't7s12.png'),
  call('p-d', 't7s12.png'),
]);
console.log(`wall4=${((Date.now() - parallelStart) / 1000).toFixed(1)}s`);
