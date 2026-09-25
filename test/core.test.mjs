import assert from 'node:assert';
import test from 'node:test';
import { cleanText, normalizeAr, pageReference, tokens } from '../lib/text.mjs';
import { publicConfig, resolveProvider } from '../lib/config.mjs';

test('تطبيع عربي: تشكيل وهمزات وتاء مربوطة', () => {
  assert.equal(normalizeAr('أحكامُ التِّلاوة'), 'احكام التلاوه');
  assert.equal(normalizeAr('القرآن الكريم'), 'القران الكريم');
});

test('إصلاح OCR والأرقام العربية', () => {
  assert.match(cleanText('املديرية العامة'), /المديرية/);
  assert.equal(pageReference('اشرح صفحة ٤٢ من الكتاب'), 42);
});

test('توكنز بدون كلمات توقف', () => {
  const result = tokens('ما هي أحكام التلاوة في القرآن');
  assert.ok(result.includes('احكام'));
  assert.ok(!result.includes('ما'));
});

test('مفتاح الجهاز يتجاوز مفتاح الخادم دون تغيير الوجهة أو النموذج', () => {
  const config = resolveProvider({
    env: { AI_API_KEY: 'server-key', AI_ENDPOINT: 'https://server.example/v1', AI_MODEL: 'M1' },
    headers: { 'x-ai-api-key': 'user-key', 'x-ai-endpoint': 'https://attacker.example/v1', 'x-ai-model': 'U1' },
  });
  assert.equal(config.key, 'user-key');
  assert.equal(config.endpoint, 'https://server.example/v1');
  assert.equal(config.model, 'M1');
  assert.equal(publicConfig(config).configured, true);
  assert.equal(publicConfig(config).key, undefined);
});

test('مفتاح b64 يُفك ورابط غير صالح يُرفض', () => {
  const raw = Buffer.from('secret123').toString('base64');
  assert.equal(resolveProvider({ env: { AI_API_KEY: `b64:${raw}`, AI_ENDPOINT: 'https://example.com/v1' } }).key, 'secret123');
  assert.equal(resolveProvider({ env: { AI_ENDPOINT: 'ftp://x' } }).error, 'INVALID_ENDPOINT');
});
