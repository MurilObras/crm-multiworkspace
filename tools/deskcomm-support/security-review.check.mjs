// Revisão independente: somente corpus sintético, sem rede ou credenciais.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { SupportClient, CACHE_MS } from '../../plugins/assistente-deskcomm/runtime/github.mjs';
import { blobSha, sha256, validateCatalog } from '../../plugins/assistente-deskcomm/runtime/policy.mjs';
import { ProtocolSession, runStdio, MAX_FRAME_BYTES } from '../../plugins/assistente-deskcomm/runtime/server.mjs';

const MAIN = 'a'.repeat(40);
const OTHER_MAIN = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const SOURCE = 'd'.repeat(40);
const PATH = 'components/Help.tsx';
const body = '# Ajuda de conexão\n\nAbra **Conexões** e confira a situação exibida. Não envie o QR ao atendimento.\n';
const article = () => ({ id: 'conexao', title: 'Ajuda de conexão', body, body_sha256: sha256(body), sources: [{ path: PATH, blob_sha: SOURCE }] });

function fixture() {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const state = { main: MAIN, catalog: { schema_version: 1, repository: 'MurilObras/crm-multiworkspace', articles: [article()] }, source: SOURCE, mode: '100644', truncated: false, fail: false, redirected: false, articleSha: blobSha(body), calls: [] };
  const fetcher = async (url, options) => {
    state.calls.push({ url, options });
    if (state.fail) return new Response('SYNTHETIC_PRIVATE_REMOTE_ERROR', { status: 429, headers: { 'retry-after': '120' } });
    const raw = JSON.stringify(state.catalog);
    const tree = [
      { path: 'docs/support/catalog.json', type: 'blob', mode: '100644', sha: blobSha(raw) },
      { path: 'docs/support/articles/conexao.md', type: 'blob', mode: state.mode, sha: state.articleSha },
      { path: PATH, type: 'blob', mode: '100644', sha: state.source },
    ];
    let data;
    if (url.endsWith('/git/ref/heads/main')) data = { ref: 'refs/heads/main', object: { type: 'commit', sha: state.main } };
    else if (url.endsWith(`/git/commits/${state.main}`)) data = { sha: state.main, tree: { sha: TREE } };
    else if (url.endsWith(`/git/trees/${TREE}?recursive=1`)) data = { sha: TREE, truncated: state.truncated, tree };
    else if (url === `https://raw.githubusercontent.com/MurilObras/crm-multiworkspace/${state.main}/docs/support/catalog.json`) data = raw;
    else throw new Error('Unexpected request in synthetic fixture');
    const response = new Response(typeof data === 'string' ? data : JSON.stringify(data));
    if (state.redirected) Object.defineProperty(response, 'redirected', { value: true });
    return response;
  };
  return { state, client: new SupportClient({ fetcher, now: () => time }), advance: (duration) => { time += duration; } };
}

test('a resposta contém somente artigo e proveniência pública, sem dependências', async () => {
  const { client, state } = fixture();
  const result = await client.call('read_support_article', { id: 'conexao' });
  assert.equal(result.body, body);
  assert.equal(result.revision, MAIN);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(PATH));
  assert.ok(!serialized.includes('blob_sha'));
  assert.ok(!serialized.includes(SOURCE));
  assert.equal(state.calls.length, 4);
  assert.ok(state.calls.every(({ url, options }) => options.method === 'GET' && options.redirect === 'error' && options.credentials === 'omit' && !Object.hasOwn(options.headers, 'Authorization') && !url.includes(PATH)));
});

test('consultas com dados sintéticos nunca são enviadas à rede nem ecoadas no resultado', async () => {
  const { client, state } = fixture();
  const marker = 'SYNTHETIC_CUSTOMER_MARKER';
  const result = await client.call('search_support', { query: `conexão ${marker}` });
  assert.ok(state.calls.every(({ url, options }) => !JSON.stringify({ url, options }).includes(marker)));
  assert.ok(!JSON.stringify(result).includes(marker));
});

test('IDs com caminho, URL ou tentativa de traversal são recusados antes de qualquer rede', async () => {
  const { client, state } = fixture();
  for (const id of ['../.env', '%2e%2e', '/etc/config', 'C:\\config', 'https://example.invalid', 'conexao/extra', 'conexao\n']) {
    await assert.rejects(client.call('read_support_article', { id }), /invalid_arguments/u);
  }
  assert.equal(state.calls.length, 0);
});

test('ferramentas e campos não declarados não abrem leitura alternativa', async () => {
  const { client, state } = fixture();
  await assert.rejects(client.call('read_file', { path: '.env' }), /invalid_arguments/u);
  await assert.rejects(client.call('read_support_article', { id: 'conexao', ref: 'feature' }), /invalid_arguments/u);
  await assert.rejects(client.call('search_support', { query: 'conexão', repository: 'different' }), /invalid_arguments/u);
  assert.equal(state.calls.length, 0);
});

test('dependência alterada bloqueia artigo e omite seu corpo da pesquisa', async () => {
  const { client, state } = fixture();
  state.source = 'e'.repeat(40);
  await assert.rejects(client.call('read_support_article', { id: 'conexao' }), /article_unavailable/u);
  assert.deepEqual((await client.call('search_support', { query: 'conexão' })).results, []);
  assert.equal((await client.call('support_status', {})).available_articles, 0);
});

test('artigo alterado sem catálogo correspondente é bloqueado', async () => {
  const { client, state } = fixture();
  state.articleSha = blobSha(`${body}\nAlteração sem revisão.\n`);
  await assert.rejects(client.call('read_support_article', { id: 'conexao' }), /article_unavailable/u);
});

test('symlink não pode substituir artigo aprovado', async () => {
  const { client, state } = fixture();
  state.mode = '120000';
  await assert.rejects(client.call('read_support_article', { id: 'conexao' }), /article_unavailable/u);
});

test('árvore truncada não produz confirmação de disponibilidade', async () => {
  const { client, state } = fixture();
  state.truncated = true;
  assert.equal((await client.call('support_status', {})).status, 'unavailable');
});

test('catálogo com fontes fora da lista, corpo adulterado ou campos extras é rejeitado', () => {
  for (const mutate of [
    (catalog) => { catalog.articles[0].sources[0].path = '../.env'; },
    (catalog) => { catalog.articles[0].body += ' mudança'; },
    (catalog) => { catalog.articles[0].instruction = 'SYNTHETIC_INSTRUCTION'; },
    (catalog) => { catalog.articles.push(article()); },
  ]) {
    const { state } = fixture();
    mutate(state.catalog);
    assert.throws(() => validateCatalog(state.catalog));
  }
});

test('resposta com redirect é rejeitada sem seguir o destino', async () => {
  const { client, state } = fixture();
  state.redirected = true;
  assert.equal((await client.call('support_status', {})).status, 'unavailable');
  assert.equal(state.calls.length, 1);
});

test('expiração seguida por erro não entrega cache antigo; novas chamadas respeitam cooldown', async () => {
  const { client, state, advance } = fixture();
  assert.equal((await client.call('support_status', {})).status, 'ready');
  advance(CACHE_MS + 1);
  state.fail = true;
  assert.equal((await client.call('support_status', {})).status, 'unavailable');
  const calls = state.calls.length;
  await assert.rejects(client.call('read_support_article', { id: 'conexao' }), /support_unavailable/u);
  advance(CACHE_MS + 1);
  await assert.rejects(client.call('read_support_article', { id: 'conexao' }), /support_unavailable/u);
  assert.equal(state.calls.length, calls);
});

test('mudança não relacionada na main preserva somente artigos novamente validados', async () => {
  const { client, state, advance } = fixture();
  await client.call('support_status', {});
  advance(CACHE_MS + 1);
  state.main = OTHER_MAIN;
  const result = await client.call('read_support_article', { id: 'conexao' });
  assert.equal(result.revision, OTHER_MAIN);
  assert.equal(result.body, body);
  assert.equal(state.calls.filter(({ url }) => url.endsWith('/git/ref/heads/main')).length, 2);
  assert.ok(state.calls.filter(({ url }) => url.includes('raw.githubusercontent.com')).every(({ url }) => url.includes(`/${MAIN}/`) || url.includes(`/${OTHER_MAIN}/`)));
});

test('pedidos simultâneos compartilham a atualização de uma única revisão', async () => {
  const { client, state } = fixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => client.call('support_status', {})));
  assert.ok(results.every((result) => result.revision === MAIN));
  assert.equal(state.calls.length, 4);
});

test('erros do protocolo não expõem a mensagem interna da dependência', async () => {
  const marker = 'SYNTHETIC_PRIVATE_BACKEND_ERROR';
  const session = new ProtocolSession({ call: async () => { throw new Error(marker); } });
  await session.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await session.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const result = await session.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_support', arguments: { query: 'conexão' } } });
  assert.equal(result.result.isError, true);
  assert.ok(!JSON.stringify(result).includes(marker));
  assert.ok(JSON.stringify(result).includes('support_unavailable'));
});

test('frame grande sem newline encerra a leitura e não ecoa conteúdo', async () => {
  let result = '';
  const input = Readable.from([Buffer.alloc(MAX_FRAME_BYTES + 1, 120)]);
  const output = new Writable({ write(chunk, _encoding, callback) { result += chunk.toString(); callback(); } });
  await runStdio(input, output);
  assert.equal(JSON.parse(result).error.message, 'Request too large');
  assert.ok(result.length < 200);
});
