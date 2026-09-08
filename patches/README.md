# Hyphenate 0.1.0

`@react-pdf/hyphenate@0.1.0` publica `exports` com apenas `types` e `import`.
O projeto nao declara `type: module`: o worker executa TS via `tsx`, cujo
loader CJS transforma os imports de `@react-pdf/textkit@7.0.1` em require.
O subpath existe em disco, mas nenhuma condicao de runtime casa, causando
`ERR_PACKAGE_PATH_NOT_EXPORTED` para `./en-us`. Import ESM nativo passa.

Cadeia: `register-handlers.ts` -> `lgpd-export-worker.handler.ts` ->
`lgpd-export-worker.ts` -> `lib/lgpd/pdf-renderer.tsx` ->
`@react-pdf/renderer@4.8.1` -> `@react-pdf/layout@5.2.0` (tambem via
`@react-pdf/render@4.7.0`) -> `@react-pdf/textkit@7.0.1` ->
`@react-pdf/hyphenate/en-us` (`0.1.0`).

O patch acrescenta `default` para os mesmos arquivos ESM, sem mudar algoritmo,
versoes ou handlers. O tsx faz a interoperabilidade CJS/ESM. Ambos os
Dockerfiles copiam o patch antes do install frozen; corrigir apenas a
instalacao local nao corrigiria as imagens distribuidas.

Regressao local, sem .env, banco ou rede externa:
`node --test tests/unit/event-log-imports.smoke.cjs` (tambem em `test:unit`).
Antes do patch os quatro casos falham: registry e cron com o erro acima,
loop com drain OFF, PDF com o mesmo erro. O teste usa processos reais para
nao deixar o bundler do Vitest esconder o problema de exports.

Remover o patch somente quando uma versao upstream exportar estes caminhos
para o loader do worker e os quatro casos continuarem passando sem ele.
