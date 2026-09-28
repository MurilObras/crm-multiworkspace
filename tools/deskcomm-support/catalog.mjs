import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  REPOSITORY, CATALOG_PATH, MAX_CATALOG_BYTES, MAX_BODY_BYTES, SupportError,
  assert, validId, validateCatalog, sha256, blobSha, sourcePath,
} from '../../plugins/assistente-deskcomm/runtime/policy.mjs';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const EVIDENCE_PATH = 'docs/support/evidence.json';

function git(root, args, input) {
  try {
    return execFileSync('git', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 2000000, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
  } catch { throw new SupportError('local_git_failed'); }
}

async function safeFile(root, path, maxBytes) {
  const absoluteRoot = await realpath(root);
  const absolute = resolve(root, path);
  assert(absolute.startsWith(`${resolve(root)}${sep}`), 'unsafe_local_path');
  // lstat em cada componente barra links de diretório, inclusive junctions Windows.
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    const info = await lstat(current);
    assert(!info.isSymbolicLink(), 'unsafe_local_path');
  }
  const final = await realpath(absolute);
  assert(final.startsWith(`${absoluteRoot}${sep}`), 'unsafe_local_path');
  const info = await lstat(absolute);
  assert(info.isFile() && info.size <= maxBytes, 'unsafe_local_file');
  return absolute;
}

async function readSafe(root, path, maxBytes) {
  const absolute = await safeFile(root, path, maxBytes);
  const bytes = await readFile(absolute);
  assert(bytes.length <= maxBytes, 'unsafe_local_file');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function sourceHash(root, path) {
  sourcePath(path);
  await safeFile(root, path, 8000000);
  const entry = git(root, ['ls-files', '--stage', '--', path]);
  assert(/^100644 [a-f0-9]{40} 0\t/u.test(entry) && !entry.includes('\n'), 'source_not_tracked');
  // hash-object sem -w não escreve objetos e não devolve o código-fonte.
  return git(root, ['hash-object', `--path=${path}`, '--', path]);
}

export async function buildCatalog(root = DEFAULT_ROOT) {
  const evidence = validateCatalog(JSON.parse(await readSafe(root, EVIDENCE_PATH, MAX_CATALOG_BYTES)), true);
  const articles = [];
  for (const article of evidence.articles) {
    for (const source of article.sources) {
      assert(await sourceHash(root, source.path) === source.blob_sha, `review_required:${article.id}`);
    }
    const path = `docs/support/articles/${article.id}.md`;
    const body = (await readSafe(root, path, MAX_BODY_BYTES)).replaceAll('\r\n', '\n');
    // O conteúdo servido deve ser exatamente o blob que um checkout/commit cria.
    const expected = git(root, ['hash-object', `--path=${path}`, '--', path]);
    assert(expected === blobSha(body), 'article_line_endings_or_filter');
    articles.push({ id: article.id, title: article.title, body, body_sha256: sha256(body), sources: article.sources });
  }
  const catalog = validateCatalog({ schema_version: 1, repository: REPOSITORY, articles });
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  assert(Buffer.byteLength(serialized, 'utf8') <= MAX_CATALOG_BYTES);
  return serialized;
}

async function safeOutput(root, path) {
  // O diretório já existe porque evidence.json foi validado. Não segue destino link.
  const parent = dirname(path).split(sep).join('/');
  const absoluteRoot = await realpath(root);
  const target = resolve(root, path);
  assert((await realpath(resolve(root, parent))).startsWith(`${absoluteRoot}${sep}`), 'unsafe_local_path');
  try {
    const info = await lstat(target);
    assert(info.isFile() && !info.isSymbolicLink(), 'unsafe_local_path');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

export async function reviewArticle(root, id) {
  assert(validId(id), 'invalid_article_id');
  const evidence = validateCatalog(JSON.parse(await readSafe(root, EVIDENCE_PATH, MAX_CATALOG_BYTES)), true);
  const article = evidence.articles.find((candidate) => candidate.id === id);
  assert(article, 'unknown_article');
  for (const source of article.sources) source.blob_sha = await sourceHash(root, source.path);
  await writeFile(await safeOutput(root, EVIDENCE_PATH), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

export async function main(args, root = DEFAULT_ROOT) {
  if (args.length === 3 && args[0] === 'review' && args[2] === '--reviewed') {
    await reviewArticle(root, args[1]);
    process.stdout.write('Evidência do artigo atualizada após revisão declarada. Execute build e check.\n');
    return;
  }
  assert(args.length === 1 && ['build', 'check'].includes(args[0]), 'usage: build | check | review <article-id> --reviewed');
  const result = await buildCatalog(root);
  if (args[0] === 'build') {
    await writeFile(await safeOutput(root, CATALOG_PATH), result, 'utf8');
    process.stdout.write('Catálogo revisado gerado.\n');
  } else {
    const existing = (await readSafe(root, CATALOG_PATH, MAX_CATALOG_BYTES)).replaceAll('\r\n', '\n');
    assert(existing === result, 'catalog_out_of_date');
    process.stdout.write('Catálogo, artigos e evidências conferidos.\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    const code = error instanceof SupportError ? error.code : 'local_validation_failed';
    // Só os códigos próprios e IDs já validados; nunca imprimir erros de Git/fs.
    process.stderr.write(`Validação de suporte: ${code}\n`);
    process.exitCode = 1;
  });
}
