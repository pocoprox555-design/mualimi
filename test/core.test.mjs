import assert from 'node:assert';
import test from 'node:test';
import { normalizeAr, tokens, cleanText } from '../lib/text.mjs';
import { resolveProvider } from '../lib/config.mjs';

test('تطبيع عربي: تشكيل وهمزات وتاء مربوطة', () => {
  assert.equal(normalizeAr('أحكامُ التِّلاوة'), 'احكام التلاوه');
  assert.equal(normalizeAr('القرآن الكريم'), 'القران الكريم');
});

test('إصلاح OCR: امل → الم', () => {
  assert.match(cleanText('املديرية العامة'), /المديرية/);
});

test('توكنز بدون كلمات توقف', () => {
  const t = tokens('ما هي أحكام التلاوة في القرآن');
  assert.ok(t.includes('احكام'));
  assert.ok(!t.includes('ما'));
});

test('إعداد المزود من التطبيق يتجاوز الخادم', () => {
  const cfg = resolveProvider({
    env: { AI_API_KEY: 'srv', AI_ENDPOINT: 'https://srv/v1', AI_MODEL: 'M1' },
    headers: { 'x-ai-api-key': 'user-key', 'x-ai-endpoint': 'https://u/v1', 'x-ai-model': 'U1' },
  });
  assert.equal(cfg.key, 'user-key');
  assert.equal(cfg.endpoint, 'https://u/v1');
  assert.equal(cfg.model, 'U1');
});

test('مفتاح b64 يُفك', () => {
  const raw = Buffer.from('secret123').toString('base64');
  const cfg = resolveProvider({ env: { AI_API_KEY: `b64:${raw}` }, headers: {} });
  assert.equal(cfg.key, 'secret123');
});

test('رابط غير صالح يُرفض', () => {
  const cfg = resolveProvider({ env: {}, headers: { 'x-ai-endpoint': 'ftp://x' } });
  assert.equal(cfg.error, 'INVALID_ENDPOINT');
});
