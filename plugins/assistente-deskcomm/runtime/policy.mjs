import { createHash } from 'node:crypto';

export const REPOSITORY = 'MurilObras/crm-multiworkspace';
export const BRANCH = 'main';
export const CATALOG_PATH = 'docs/support/catalog.json';
export const MAX_ARTICLES = 100;
export const MAX_BODY_BYTES = 24000;
export const MAX_CATALOG_BYTES = 1500000;
export const ARTICLE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SHA = /^[a-f0-9]{40}$/;
export const SHA256 = /^[a-f0-9]{64}$/;

export class SupportError extends Error {
  constructor(code = 'support_unavailable') {
    super(code);
    this.code = code;
  }
}

export function assert(condition, code = 'invalid_catalog') {
  if (!condition) throw new SupportError(code);
}

export function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exactKeys(value, keys) {
  assert(object(value));
  assert(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function blobSha(value) {
  const bytes = Buffer.from(value, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function validId(value) {
  return typeof value === 'string' && value.length <= 80 && ARTICLE_ID.test(value);
}

// Defesa adicional, NÃO certificação de ausência de segredos. A fronteira principal
// é publicar somente artigos revisados: não entregar código bruto ao assistente.
export function safePublicText(value, maxBytes = MAX_BODY_BYTES) {
  assert(typeof value === 'string' && value.trim().length > 0);
  assert(Buffer.byteLength(value, 'utf8') <= maxBytes);
  assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value));
  const forbidden = [
    /`|~~~|<[^>]*>/u,
    /(?:[a-z][a-z0-9+.-]*:\/\/|(?:https?|file|data|javascript|mailto):|www\.)/iu,
    /!?\[[^\]\n]*\]\s*\(|^\s*\[[^\]\n]+\]:/mu,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
    /\b(?:\d{1,3}\.){3}\d{1,3}\b/u,
    /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|(?:\+\d{1,3}[ -]?)?\(?\d{2}\)?[ -]?\d{4,5}[ -]\d{4}\b/u,
    /\b(?:gh[pousr]_|github_pat_|sk[-_](?:live|test|proj)?|xox[baprs]-|AKIA|ASIA)[A-Za-z0-9_-]{12,}/u,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u,
    /-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/u,
    /\b(?:password|passwd|senha|secret|token|api[_ -]?key|credential)\s*[:=]\s*\S/iu,
    /\b[A-Za-z0-9+/=_-]{48,}\b/u,
    /(?:^|[\s/])\.env(?:\b|\.)/iu,
    /\b(?:app|lib|supabase|workers|\.github|node_modules)\/[A-Za-z0-9_./()[\]-]+/u,
    /^\s*(?:(?:export\s+)?(?:const|let|var|function|class|import)\s+\w|(?:SELECT|INSERT INTO|ALTER TABLE|CREATE TABLE)\s)/mu,
    /(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|system)\s+instructions|ignore\s+(?:as\s+)?instruções\s+anteriores/iu,
  ];
  assert(!forbidden.some((pattern) => pattern.test(value)), 'unsafe_article');
  return value;
}

export function sourcePath(path) {
  assert(typeof path === 'string' && path.length <= 240);
  assert(/^[A-Za-z0-9][A-Za-z0-9_./()[\] -]*$/u.test(path));
  assert(path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'));
  assert(!/(?:^|\/)(?:\.env[^/]*|node_modules|\.git|secrets?|credentials?|fixtures?|dumps?|backups?)(?:\/|$)/iu.test(path));
  assert(!/(?:^|\/)(?:[^/]*\.(?:pem|key|p12|pfx|sql|csv|log)|[^/]*secret[^/]*|[^/]*credential[^/]*)$/iu.test(path));
  const allowed = /^(?:README\.md|docs\/(?!support\/)[A-Za-z0-9_./()[\] -]+\.md|(?:app|components|hooks|tests|lib)\/[A-Za-z0-9_./()[\] -]+\.(?:tsx?|mjs))$/u;
  assert(allowed.test(path));
  // Infraestrutura/auth concreta não precisa virar evidência de orientação pública.
  assert(!/^(?:lib\/(?:env|supabase\/admin)|app\/api\/(?:internal|mcp))\b/u.test(path));
  return path;
}

export function validateSources(sources) {
  assert(Array.isArray(sources) && sources.length >= 1 && sources.length <= 30);
  const seen = new Set();
  for (const source of sources) {
    exactKeys(source, ['path', 'blob_sha']);
    sourcePath(source.path);
    assert(typeof source.blob_sha === 'string' && SHA.test(source.blob_sha));
    assert(!seen.has(source.path));
    seen.add(source.path);
  }
}

export function validateCatalog(catalog, evidenceOnly = false) {
  exactKeys(catalog, ['schema_version', 'repository', 'articles']);
  assert(catalog.schema_version === 1 && catalog.repository === REPOSITORY);
  assert(Array.isArray(catalog.articles) && catalog.articles.length >= 1 && catalog.articles.length <= MAX_ARTICLES);
  const ids = new Set();
  for (const article of catalog.articles) {
    exactKeys(article, evidenceOnly ? ['id', 'title', 'sources'] : ['id', 'title', 'body', 'body_sha256', 'sources']);
    assert(validId(article.id) && !ids.has(article.id));
    ids.add(article.id);
    safePublicText(article.title, 160);
    assert(!/[\r\n]/u.test(article.title));
    validateSources(article.sources);
    if (!evidenceOnly) {
      safePublicText(article.body);
      assert(typeof article.body_sha256 === 'string' && SHA256.test(article.body_sha256));
      assert(sha256(article.body) === article.body_sha256);
    }
  }
  return catalog;
}

export function regularBlob(entry) {
  return object(entry) && entry.type === 'blob' && entry.mode === '100644' && typeof entry.sha === 'string' && SHA.test(entry.sha);
}

export function articleIsCurrent(article, tree) {
  const entry = tree.get(`docs/support/articles/${article.id}.md`);
  if (!regularBlob(entry) || entry.sha !== blobSha(article.body)) return false;
  return article.sources.every((source) => {
    const dependency = tree.get(source.path);
    return regularBlob(dependency) && dependency.sha === source.blob_sha;
  });
}

export function validateToolArguments(name, args) {
  if (!object(args)) throw new SupportError('invalid_arguments');
  const keys = Object.keys(args);
  if (name === 'support_status' && keys.length === 0) return args;
  if (name === 'read_support_article' && keys.length === 1 && keys[0] === 'id' && validId(args.id)) return args;
  if (name === 'search_support' && keys.length === 1 && keys[0] === 'query' && typeof args.query === 'string' && args.query.trim().length > 0 && args.query.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(args.query)) return args;
  throw new SupportError('invalid_arguments');
}
