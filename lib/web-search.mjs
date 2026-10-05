import { resolveWebSearch } from './config.mjs';

const MAX_CACHE_ENTRIES = 128;
const MAX_RESPONSE_BYTES = 1_000_000;
const cache = new Map();

function clean(value, max = 1_000) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function searchText(query, { preferCurriculum = false, subject = '', track = '' } = {}) {
  const suffix = preferCurriculum
    ? `وزارة التربية العراقية المنهج العراقي الصف السادس الإعدادي ${clean(subject, 80)} ${clean(track, 40)}`
    : '';
  return clean(`${query} ${suffix}`, 500);
}

function sourceKind(url, title, snippet) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return { host, official: false, curriculumSpecific: false, rank: 0 }; }
  const text = `${title} ${snippet}`;
  const official = /(?:^|\.)gov\.iq$/.test(host) || /(?:^|\.)edu\.gov\.iq$/.test(host);
  const curriculumSpecific = /المنهج العراقي|المناهج العراقية|كتاب السادس الإعدادي|السادس الإعدادي|الصف السادس الإعدادي|منهاج العراق/i.test(text);
  return { host, official, curriculumSpecific, rank: official ? 2 : curriculumSpecific ? 1 : 0 };
}

function normalizeResults(payload, maxResults, { preferCurriculum = false } = {}) {
  const rows = payload?.web?.results || payload?.results || payload?.items || payload?.data?.results || [];
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const results = [];
  for (const row of rows) {
    const title = clean(row?.title || row?.name, 240);
    const rawUrl = clean(row?.url || row?.link, 1_500);
    const snippet = clean(row?.description || row?.snippet || row?.content || row?.text, 900);
    let url;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') continue;
      url = parsed.toString();
    } catch { continue; }
    if (!title || !snippet || seen.has(url)) continue;
    seen.add(url);
    results.push({ title, url, snippet, ...sourceKind(url, title, snippet) });
  }
  const scoped = preferCurriculum
    ? results.filter((item) => item.curriculumSpecific)
    : results;
  return scoped
    .sort((a, b) => b.rank - a.rank)
    .slice(0, maxResults)
    .map((item, index) => ({
      id: `W${index + 1}`,
      ...item,
      evidenceType: 'external-web',
      sourceType: 'web',
    }));
}

function cloneResults(results) {
  return results.map((item) => ({ ...item }));
}

function cached(key, now) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return cloneResults(entry.results);
}

function store(key, results, ttl, now) {
  if (!ttl) return;
  cache.delete(key);
  cache.set(key, { results: cloneResults(results), expiresAt: now + ttl });
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
}

async function responseText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('WEB_SEARCH_RESPONSE_TOO_LARGE');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function withTimeout(parent, milliseconds) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(parent?.reason || new Error('ABORTED'));
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('WEB_SEARCH_TIMEOUT'));
  }, milliseconds);
  parent?.addEventListener('abort', onAbort, { once: true });
  if (parent?.aborted) onAbort();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

export async function searchWeb(query, {
  config = resolveWebSearch(),
  signal,
  preferCurriculum = false,
  subject = '',
  track = '',
} = {}) {
  const text = searchText(query, { preferCurriculum, subject, track });
  if (!text || !config?.enabled || !config.endpoint || !config.key) return [];

  const key = `${config.endpoint}|${preferCurriculum ? 'curriculum' : 'general'}|${text.toLocaleLowerCase()}`;
  const now = Date.now();
  const hit = cached(key, now);
  if (hit) return hit;
  if (signal?.aborted) throw signal.reason || new Error('ABORTED');

  const url = new URL(config.endpoint);
  url.searchParams.set('q', text);
  url.searchParams.set('count', String(config.maxResults));
  url.searchParams.set('country', 'IQ');
  url.searchParams.set('search_lang', 'ar');
  url.searchParams.set('safesearch', 'moderate');
  const timeout = withTimeout(signal, config.timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': config.key,
        'User-Agent': 'mualimi/3.0',
      },
      signal: timeout.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`WEB_SEARCH_HTTP_${response.status}`);
    }
    const raw = await responseText(response);
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error('WEB_SEARCH_INVALID_RESPONSE'); }
    const results = normalizeResults(payload, config.maxResults, { preferCurriculum });
    store(key, results, config.cacheTtlMs, Date.now());
    return cloneResults(results);
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    if (timeout.timedOut() || error?.name === 'AbortError') throw new Error('WEB_SEARCH_TIMEOUT');
    throw error;
  } finally {
    timeout.dispose();
  }
}
