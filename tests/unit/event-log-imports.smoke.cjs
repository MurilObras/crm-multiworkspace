/* eslint-disable @typescript-eslint/no-require-imports -- Exerce o loader CJS real do worker. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");

// Processo real com tsx/CJS como no worker. Sem Vitest/Vite mascarando exports,
// sem setup que le .env e sem mocks do registry, handlers ou renderer.
const setup = `
  const assert = require('node:assert/strict');
  const blocked = () => { throw new Error('Network forbidden in import smoke test'); };
  const localFetch = globalThis.fetch;
  // Yoga carrega WASM embutido em data URI, nao pela rede.
  globalThis.fetch = (url, options) => String(url).startsWith('data:')
    ? localFetch(url, options) : blocked();
  require('node:net').Socket.prototype.connect = blocked;
  require('node:tls').connect = blocked;
  for (const name of ['node:http', 'node:https']) {
    const mod = require(name);
    mod.request = blocked;
    mod.get = blocked;
  }
`;

for (const [name, code] of Object.entries({
  registry: `
    const { ensureHandlersRegistered } = require('./lib/event-log/register-handlers');
    const { getRegisteredHandlers } = require('./lib/event-log/dispatcher');
    const { campaignHandler } = require('./lib/campaigns/worker');
    const { lgpdExportHandler } = require('./workers/lgpd-export-worker.handler');
    ensureHandlersRegistered();
    const handlers = [...getRegisteredHandlers()];
    assert.ok(handlers.includes(campaignHandler));
    assert.ok(handlers.includes(lgpdExportHandler));
    ensureHandlersRegistered();
    assert.deepEqual(getRegisteredHandlers(), handlers);
  `,
  loop: `
    const { runEventLogDrainLoop } = require('./lib/event-log/drain-loop');
    const { getRegisteredHandlers } = require('./lib/event-log/dispatcher');
    const { campaignHandler } = require('./lib/campaigns/worker');
    const warnings = [];
    // Abortar ANTES do primeiro tick ainda executa carregarDeps e cria o admin
    // real, mas nao consulta banco nem executa efeitos dos handlers.
    await runEventLogDrainLoop(
      { intervalMs: 0, idleIntervalMs: 0, batchSize: 1 },
      { info() {}, warn(...args) { warnings.push(args); }, error: assert.fail },
      AbortSignal.abort(),
    );
    assert.deepEqual(warnings, [], 'drain must not switch OFF');
    assert.ok(getRegisteredHandlers().includes(campaignHandler));
  `,
  cron: `
    const { GET, POST } = require('./app/api/v1/cron/event-log-drain/route');
    assert.equal(typeof POST, 'function');
    const response = await GET(new Request('https://test.invalid/api/v1/cron/event-log-drain'));
    assert.equal(response.status, 403);
  `,
  pdf: `
    const React = require('react');
    const { Document, Page, Text, renderToBuffer } = require('@react-pdf/renderer');
    const pdf = await renderToBuffer(React.createElement(Document, null,
      React.createElement(Page, null, React.createElement(Text, null, 'Hyphenation regression test'))));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const esm = await import('@react-pdf/renderer');
    assert.equal(typeof esm.renderToBuffer, 'function');
  `,
})) {
  test(name, { timeout: 60_000 }, () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `${setup}\n(async () => { ${code} })().catch(error => { console.error(error); process.exitCode = 1; });`,
      ],
      {
        cwd: require("node:path").resolve(__dirname, "../.."),
        // Apenas variaveis do SO necessarias ao Node/esbuild no Windows.
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          NODE_ENV: "test",
          NEXT_PUBLIC_SUPABASE_URL: "https://test.invalid",
          NEXT_PUBLIC_SUPABASE_ANON_KEY: "fake-anon-key",
          SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
          INTERNAL_SECRET: "fake-internal-secret",
        },
        encoding: "utf8",
        timeout: 55_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
