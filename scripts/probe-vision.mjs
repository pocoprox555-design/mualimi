// Verifies whether the configured model can actually read images, because the
// only recovery path for damaged text is sending the rendered PDF page.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { loadEnvFile } from 'node:process';
import { resolveProvider } from '../lib/config.mjs';

loadEnvFile('.env');
const config = resolveProvider({});

// Reuse the project's own page renderer so the test uses the real pipeline.
const require = createRequire(import.meta.url);
const canvasApi = require('@napi-rs/canvas');
globalThis.Path2D ||= canvasApi.Path2D;
globalThis.DOMMatrix ||= canvasApi.DOMMatrix;
globalThis.ImageData ||= canvasApi.ImageData;
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const { readPdfPage } = await import('../lib/pdf-fallback.mjs');

const target = process.argv[2] || 'hadith-deni-sixth';
const pageNumber = Number(process.argv[3] || 60);

const page = await readPdfPage({ bookId: target, physicalPage: pageNumber, forceSource: true });
console.log(`book=${target} physical=${pageNumber} status=${page.status} textLen=${(page.text || '').length} hasImage=${Boolean(page.imageDataUrl)} pdfOpened=${page.pdfOpened}`);

if (!page.imageDataUrl) {
  console.log('no page image available; vision cannot be tested on this page.');
  process.exit(0);
}

const question = 'Read the page image. Reply with ONLY the first heading or section title you can actually read, or exactly NONE if you cannot see any text.';

async function attempt(label, content) {
  const started = Date.now();
  try {
    const response = await fetch(`${config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}`, 'x-opencode-session': 'vision-probe' },
      body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content }], max_tokens: 4000 }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.log(`${label}: HTTP ${response.status} â€” ${body.slice(0, 220)}`);
      return;
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    console.log(`${label}: ${Date.now() - started}ms -> ${JSON.stringify(String(text).slice(0, 200))}`);
    if (data?.usage) console.log(`   usage: ${JSON.stringify(data.usage)}`);
  } catch (error) {
    console.log(`${label}: FAILED ${String(error?.message || error).slice(0, 200)}`);
  }
}

await attempt('with-image', [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: page.imageDataUrl } }]);
await attempt('text-only-control', question);

await writeFile('.probe-vision.json', JSON.stringify({
  book: target, physicalPage: pageNumber, status: page.status, imageChars: page.imageDataUrl.length,
}, null, 2), 'utf8');