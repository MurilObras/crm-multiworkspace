import {
  REPOSITORY, BRANCH, CATALOG_PATH, MAX_CATALOG_BYTES, SHA, SupportError,
  assert, object, blobSha, validateCatalog, regularBlob, articleIsCurrent, validateToolArguments,
} from './policy.mjs';

export const CACHE_MS = 60000;
const REQUEST_TIMEOUT_MS = 7000;
const API = `https://api.github.com/repos/${REPOSITORY}`;
const RAW = `https://raw.githubusercontent.com/${REPOSITORY}`;
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const unavailable = () => new SupportError('support_unavailable');

// Só recebe URLs construídas aqui; jamais usa query, caminho, ref ou URL do usuário.
async function limitedFetch(fetcher, url, maxBytes, json, signal) {
  const response = await fetcher(url, {
    method: 'GET', redirect: 'error', credentials: 'omit',
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    headers: { Accept: json ? 'application/vnd.github+json' : 'text/plain', 'User-Agent': 'deskcomm-support-readonly/1', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!response.ok || response.redirected) {
    const error = unavailable();
    const retry = response.headers.get('retry-after');
    const reset = response.headers.get('x-ratelimit-reset');
    const retryMs = retry && /^\d+$/u.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 0;
    const resetMs = reset && /^\d+$/u.test(reset) ? Number(reset) * 1000 - Date.now() : 0;
    error.cooldown = Math.min(86400000, Math.max(CACHE_MS, Number.isFinite(retryMs) ? retryMs : 0, Number.isFinite(resetMs) ? resetMs : 0));
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel().catch(() => {});
    throw unavailable();
  }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const buffers = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > maxBytes) throw unavailable();
      buffers.push(Buffer.from(item.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const text = textDecoder.decode(Buffer.concat(buffers));
  return json ? JSON.parse(text) : text;
}

function treeMap(data, treeSha) {
  assert(object(data) && data.sha === treeSha && data.truncated === false && Array.isArray(data.tree), 'support_unavailable');
  assert(data.tree.length <= 50000, 'support_unavailable');
  const entries = new Map();
  for (const entry of data.tree) {
    assert(object(entry) && typeof entry.path === 'string' && entry.path.length <= 1024 && !entries.has(entry.path), 'support_unavailable');
    entries.set(entry.path, entry);
  }
  return entries;
}

function normalize(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}

export class SupportClient {
  #fetch;
  #now;
  #snapshot = null;
  #pending = null;
  #retryAt = 0;

  // Injeções existem só para testes/importação; o servidor não as recebe por CLI/env/MCP.
  constructor({ fetcher = globalThis.fetch, now = Date.now } = {}) {
    this.#fetch = fetcher;
    this.#now = now;
  }

  async #load() {
    const started = this.#now();
    const signal = AbortSignal.timeout(25000);
    const ref = await limitedFetch(this.#fetch, `${API}/git/ref/heads/${BRANCH}`, 16384, true, signal);
    assert(object(ref) && ref.ref === 'refs/heads/main' && object(ref.object) && ref.object.type === 'commit' && SHA.test(ref.object.sha), 'support_unavailable');
    const sha = ref.object.sha;
    // Nova consulta de main confirma que metadados imutáveis anteriores ainda valem.
    if (this.#snapshot?.sha === sha) {
      this.#snapshot.checked = started;
      return this.#snapshot;
    }
    const commit = await limitedFetch(this.#fetch, `${API}/git/commits/${sha}`, 1000000, true, signal);
    assert(object(commit) && commit.sha === sha && object(commit.tree) && typeof commit.tree.sha === 'string' && SHA.test(commit.tree.sha), 'support_unavailable');
    const treeSha = commit.tree.sha;
    const treeData = await limitedFetch(this.#fetch, `${API}/git/trees/${treeSha}?recursive=1`, 8000000, true, signal);
    const tree = treeMap(treeData, treeSha);
    const catalogEntry = tree.get(CATALOG_PATH);
    assert(regularBlob(catalogEntry), 'support_unavailable');
    const rawCatalog = await limitedFetch(this.#fetch, `${RAW}/${sha}/${CATALOG_PATH}`, MAX_CATALOG_BYTES, false, signal);
    assert(blobSha(rawCatalog) === catalogEntry.sha, 'support_unavailable');
    const catalog = validateCatalog(JSON.parse(rawCatalog));
    const articles = catalog.articles.filter((article) => articleIsCurrent(article, tree));
    const snapshot = { sha, checked: started, articles, blocked: catalog.articles.length - articles.length };
    assert(this.#now() - started < CACHE_MS, 'support_unavailable');
    this.#snapshot = snapshot;
    return snapshot;
  }

  async snapshot() {
    const age = this.#snapshot ? this.#now() - this.#snapshot.checked : Infinity;
    if (age >= 0 && age < CACHE_MS) return this.#snapshot;
    if (this.#now() < this.#retryAt) throw unavailable();
    if (!this.#pending) {
      this.#pending = this.#load().catch((error) => {
        // Uma falha de atualização invalida também o último cache bem sucedido.
        this.#snapshot = null;
        this.#retryAt = this.#now() + (error instanceof SupportError && Number.isFinite(error.cooldown) ? error.cooldown : CACHE_MS);
        throw unavailable();
      }).finally(() => { this.#pending = null; });
    }
    return this.#pending;
  }

  async call(name, args) {
    validateToolArguments(name, args);
    let snapshot;
    try { snapshot = await this.snapshot(); } catch {
      if (name === 'support_status') return { status: 'unavailable', message: 'Não foi possível confirmar a documentação atual. Não responda usando uma cópia antiga.' };
      throw unavailable();
    }
    const metadata = {
      revision: snapshot.sha,
      checked_at: new Date(snapshot.checked).toISOString(),
      source: 'Central de ajuda revisada',
      branch: BRANCH,
    };
    if (name === 'support_status') {
      return { status: snapshot.articles.length === 0 ? 'unavailable' : snapshot.blocked > 0 ? 'partial' : 'ready', available_articles: snapshot.articles.length, blocked_articles: snapshot.blocked, ...metadata };
    }
    if (name === 'read_support_article') {
      const article = snapshot.articles.find((candidate) => candidate.id === args.id);
      if (!article) throw new SupportError('article_unavailable');
      return { id: article.id, title: article.title, body: article.body, ...metadata };
    }
    const words = [...new Set(normalize(args.query).match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 40);
    const results = snapshot.articles.map((article) => {
      const title = normalize(article.title);
      const body = normalize(article.body);
      const score = words.reduce((sum, word) => sum + (title.includes(word) ? 3 : 0) + (body.includes(word) ? 1 : 0), 0);
      return { article, score };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.article.id.localeCompare(b.article.id)).slice(0, 5).map(({ article }) => ({ id: article.id, title: article.title, excerpt: article.body.slice(0, 280) }));
    return { results, ...metadata };
  }
}
