# Campaigns Audience And Scheduling

## Contrato

CONFIRMADO no codigo: publico por tag/origem continua usando o recorte existente.
Paste aceita linha, virgula e ponto e virgula; CSV usa os helpers de contatos;
XLSX le a primeira aba no servidor com read-excel-file. Telefone obrigatorio,
nome opcional, demais colunas ignoradas. Limites herdados: 500 linhas e 5 MB;
XLSX tambem limita o diretorio ZIP a 25 MB expandidos e 1000 entradas.
Preview nao escreve no banco nem em storage. So validos unicos sao confirmados.

prepare_whatsapp_campaign (0219) reutiliza fn_upsert_wa_contact dentro da mesma
transacao que grava recipients, passo zero e evento. Nunca busca contatos em outra
org. Repetir o UUID na mesma org nao refaz publico, contatos ou evento; outra org
recebe conflito. A RPC 0218 permanece disponivel para pedidos existentes.

Agendar exige instante futuro no banco. A UI usa instanteDe com fuso explicito,
enviando UTC. event_log.next_attempt_at guarda o prazo e o worker chama
start_scheduled_whatsapp_campaign: antes do prazo retorna retry, no prazo muda
scheduled para running uma unica vez. O publico ja esta congelado. started_at
marca a ativacao real para stopped_reply, nao o momento de criar o agendamento.

## Sistema Vivo

Entrada: registry sidebar/busca e /app/campaigns. Saida: sendMessageHandler e
finalize_whatsapp_campaign_step. Log: whatsapp_campaign.launched na API e
whatsapp_campaign.requested no event_log. Anti-morte: scheduler/drain existente
processa eventos persistidos sem browser. Retorno: recipient_steps mostra
failed/failure_reason para inspecao; transporte incerto nunca volta a pending.
Quota do canal, delays, opt-out/is_blocked e stopped_reply permanecem no caminho
homologado. Mapa: docs/architecture/campaigns.architecture.json.

## Verificacao

- `corepack pnpm exec vitest run --config tests/campaigns/vitest.config.ts`
- `node --test tests/campaigns/postgres-check.mjs` com CAMPAIGNS_EMBEDDED_PG e CAMPAIGNS_TEST_TEMP apontando para instalacao e diretorio descartaveis.
- `node --test tests/campaigns/browser-check.mjs` com CAMPAIGNS_TEST_TEMP e, se necessario, CAMPAIGNS_BROWSER_CHANNEL=msedge.
- `corepack pnpm typecheck`
- `corepack pnpm exec eslint app/api/v1/campaigns app/app/campaigns lib/campaigns lib/navigation/registry.ts tests/campaigns`
- `git diff --check`

Resultado local em 2026-09-08: 191 testes em 12 arquivos passaram, 22 testes
Postgres passaram e 2 jornadas de browser (desktop/mobile, incluindo os tres
modos) passaram. Typecheck, lint focado e release:conferir passaram.
Screenshots: `C:\Users\muril\AppData\Local\Temp\opencode\campaigns-ui-X7uvgQ`.
O harness usa Edge instalado (CAMPAIGNS_BROWSER_CHANNEL=msedge); Chromium do
Playwright nao estava instalado. PostgreSQL embarcado inicializado UTF-8/C,
evitando o default WIN1252 do Windows. O teste exato do sidebar foi atualizado
para cobrar Campanhas, conforme o novo requisito, sem afrouxar a lista.

O teste PG aplica 0218/0219 e o upsert real da 0198 em dependencias minimas;
nao e o baseline completo de instalacao. Confere igualdade integral dos dois
apendices: 0218 termina no marcador 0219, 0219 termina na varredura anon final.
O teste de navegador dirige componente/CSS reais em desktop/mobile com API
simulada; nao prova Supabase/Auth/WAHA reais. Docker ausente neste ambiente:
instalacao/update do baseline completo e jornada fresca continuam gates externos.
O config isolado nao carrega .env; a suite global padrao carrega .env/.env.local
e nao foi usada nesta verificacao para evitar configuracao real.
