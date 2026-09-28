import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCatalog, reviewArticle } from './catalog.mjs';
import { REPOSITORY, blobSha } from '../../plugins/assistente-deskcomm/runtime/policy.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'deskcomm-support-test-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) && basename(root).startsWith('deskcomm-support-test-'));
    return rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'docs/support/articles'), { recursive: true });
  await mkdir(join(root, 'components'));
  await writeFile(join(root, '.gitattributes'), '* text eol=lf\n');
  await writeFile(join(root, 'components/start.tsx'), 'export const start = true;\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['add', '--', '.gitattributes', 'components/start.tsx'], { cwd: root, stdio: 'pipe' });
  const evidence = { schema_version: 1, repository: REPOSITORY, articles: [{ id: 'primeiros-passos', title: 'Primeiros passos', sources: [{ path: 'components/start.tsx', blob_sha: blobSha('export const start = true;\n') }] }] };
  await writeFile(join(root, 'docs/support/evidence.json'), JSON.stringify(evidence));
  await writeFile(join(root, 'docs/support/articles/primeiros-passos.md'), '# Primeiros passos\n\nAbra seu workspace.\n');
  return { root, evidence };
}

test('builder binds reviewed evidence to local source hashes; changed source requires review', async (t) => {
  const { root } = await fixture(t);
  const initial = JSON.parse(await buildCatalog(root));
  assert.equal(initial.articles.length, 1);
  await writeFile(join(root, 'components/start.tsx'), 'export const start = false;\n');
  await assert.rejects(buildCatalog(root), /review_required:primeiros-passos/);
  await reviewArticle(root, 'primeiros-passos');
  const updated = JSON.parse(await buildCatalog(root));
  assert.notEqual(updated.articles[0].sources[0].blob_sha, initial.articles[0].sources[0].blob_sha);
  assert.equal(updated.articles[0].body, initial.articles[0].body);
});

test('builder never silently refreshes evidence or accepts untracked/sensitive sources', async (t) => {
  const { root, evidence } = await fixture(t);
  const before = await readFile(join(root, 'docs/support/evidence.json'), 'utf8');
  await buildCatalog(root);
  assert.equal(await readFile(join(root, 'docs/support/evidence.json'), 'utf8'), before);
  evidence.articles[0].sources[0].path = '.env';
  await writeFile(join(root, 'docs/support/evidence.json'), JSON.stringify(evidence));
  await assert.rejects(buildCatalog(root), /invalid_catalog/);
  evidence.articles[0].sources[0].path = 'components/untracked.tsx';
  await writeFile(join(root, 'components/untracked.tsx'), 'safe synthetic file\n');
  await writeFile(join(root, 'docs/support/evidence.json'), JSON.stringify(evidence));
  await assert.rejects(buildCatalog(root), /source_not_tracked/);
});

test('builder rejects synthetic secrets and a linked article before publishing', async (t) => {
  const { root } = await fixture(t);
  const path = join(root, 'docs/support/articles/primeiros-passos.md');
  await writeFile(path, 'token = synthetic_private_value\n');
  await assert.rejects(buildCatalog(root), /unsafe_article/);
  await rm(path);
  try { await symlink(join(root, 'components/start.tsx'), path, 'file'); } catch (error) {
    if (error.code === 'EPERM') { t.diagnostic('Link de arquivo indisponível neste host; rejeição de symlinks remotos coberta separadamente.'); return; }
    throw error;
  }
  await assert.rejects(buildCatalog(root), /unsafe_local_path/);
});
