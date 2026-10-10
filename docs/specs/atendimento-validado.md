# Correções do atendimento validado

## Fluxo de implementação

Branch `fix/EPIC-03-atendimento-validado` criada da main depois dos PRs anteriores
integrados. PR próprio, sem reaproveitar PR encerrado, sem merge/deploy automático.
Nenhuma migration: mantém tabelas, RLS, autenticação e contratos de assinatura.

## Correções e critérios de aceite

| Origem | ID | Entrega | Prova |
| --- | --- | --- | --- |
| Testes | F01 | Seletor de acompanhamento usa `channelLabel`, com telefone/sessão quando não há apelido | Jornada visual em Webhooks > Obra no Bolso |
| Testes | F09 | Salvar proteção reavalia somente inbound retido daquele workspace/canal | `tests/unit/inbound-pending.test.ts`: SQL em PGlite; auditoria e aviso na ficha |
| Testes | F09/F10 | Debounce só junta rajadas da mesma conversa/canal; atualiza âncora e chave do evento | Mesmo teste: isolamentos, retomada única e exclusão de jobs retidos |
| Testes | F10 | Turno ultrapassado não gasta LLM; nova inbound durante geração/espera interrompe envio | `tests/invariants/inbound-retomada-e-midia.test.ts`: turno real, modelo/canal sintéticos, Postgres efêmero |
| Testes | F06 | Negrito Markdown vira negrito WhatsApp no adapter, preservando código, URLs e templates aprovados | `tests/unit/whatsapp-text.test.ts` e teste do passthrough de template |
| Testes + usuário | F07/U07 | `send_message` aceita imagem/vídeo HTTPS aprovado; Storage privado antes do envio, sem dividir legenda nem duplicar arquivo | Invariante do turno e `tests/unit/agent-media-storage.test.ts`: SQL embarcado, sink real e transporte sintético |
| Usuário + testes | U01–U06/F08/F11/M01–M04 | Nome, transparência, concisão, equipe no plano profissional e primeiro encaminhamento | Configuração de versões pelo responsável, somente no workspace desejado; reteste real separado |

Foto/vídeo usa URL real aprovada nas instruções/base, nunca arquivo inventado.
O preparo verifica posse da conversa, destino público, tipo e tamanho (50 MB),
recusa redirects e guarda o arquivo sob o prefixo do workspace/conversa.
O sink assina esse objeto; apenas `media_url` não seleciona seu ramo de mídia.
O objeto inclui o hash do conteúdo para que preparo atrasado não substitua
o arquivo de outra tentativa. O replay persistido conserva objeto/identidade.
A conversa é reavaliada após o
download para evitar resposta superada durante o preparo. A proteção de DNS
reutiliza a política de webhooks, inclusive a janela residual de rebinding
documentada em `outbound-ip.ts`; não declara conexão fixada por IP.
O transporte e a política continuam em `executeOutboundAttempt`/`sendMessageHandler`.
Não se habilita `crm_send_whatsapp_message` diretamente no agente: essa tool
continua bloqueada para impedir envio por fora dos guardrails.

## Pendências que não são falhas reproduzidas de código

- F02: o preview do site comercial pertence à origem desse site, que não foi
  localizada nos dois repositórios informados; não alterar metadados do dashboard.
- F03: Inbox tem autenticação de realtime e refetch de segurança; exige reprodução
  com erro concreto antes de outro ajuste. Não afirmar correção por leitura de fonte.
- I01: execuções do agente já consultam `llm_calls.agent_id`; histórico anterior sem
  vínculo não permite backfill seguro. Verificar novos runs depois das versões novas.
- U09: Execuções está em Agente de IA > Ver tudo em IA; respeita role manager.
- F04: desbloqueio de contato exige avaliar consentimento e fluxo de operação;
  não remover opt-out automaticamente.
- U10: importação já existe no acervo. Documento de atendimento adicional ainda
  não recebido; foto de observações não é esse documento.
- I02/I05: contexto foi reduzido pelas telas; latência/memória exigem medir novo run.
- I03: cap continua compartilhado pelo número e não foi aumentado. O contador do
  motor mede envio lógico; divisão em bolhas não equivale a N contagens do cap.
- Ciclo 96h, mensagens únicas e recuperação ficam sujeitos à validação temporal
  controlada; este lote não ativa os envios dessa integração.

## Living System Checklist

1. Entrada: eventos `ai_agent.dispatch_requested` e PUT autenticado `/ai/pacing`.
2. Saída: job inbound atual, `runBeforeSend`, adapter e sink existente.
3. Registro: `ai.pacing_knobs_updated` inclui quantidade reavaliada/falha;
   descarte/interrupção emite `send_vetoed` pelo barramento de atividades,
   com motivo legível e fase, sem conteúdo ou telefone.
4. Tela: ficha Proteção de envio confirma retomada ou avisa falha parcial;
   descarte aparece na timeline do negócio (Inbox/Atividades). Se não houver
   negócio aberto único, o emissor registra `agent.activity_unrouted` sem adivinhar
   o destino; essa exceção conserva o diagnóstico nos logs/eventos, sem nova tela.
5. Porta: Conexões > Proteção de envio; Webhooks > Obra no Bolso; hub IA > Execuções.
6. Anti-morte: resposta nova não fica atrás do cap antigo; retenção passa novamente
   pelos gates. Se mensagem antiga for descartada, a nova inbound conserva seu evento/job.
7. Configuração: número e proteção existentes; arquivos oficiais são autorizados
   pelas instruções publicadas/material consultado, sem constante de workspace.
8. Continuidade: não remove pausa humana/opt-out nem reativa follow-up; as guardas
   existentes continuam antes de cada envio. Murilo e tom são configurações locais.
9. Retorno: falha de reavaliação aparece no salvamento/auditoria para nova tentativa;
   novo inbound impede resposta ao assunto anterior antes do transporte.
10. Mapa: `agent-turn.workflow.json`, observações sobre retomada e mídia; jornada de
    validação em `docs/testing/user-journey-map.md`.

## Validação

Sem banco ou dados de produção nos testes. PGlite isola SQL das filas; o harness
`test-db.sh` cria/remova seu próprio Postgres e usa modelo/transporte sintéticos.
Ambiente Windows registrou falhas em ferramentas POSIX/varreduras; os casos
afetados passaram em Linux/Node 22. O CI segue necessário antes do merge.
Roteiro visual: número sem apelido legível; salvar proteção mostra sucesso/aviso;
rajada muda de assunto; pedido de humano; demonstração em arquivo recebida uma vez.
Entrega real do arquivo e o ciclo 96h não são provados por modelos sintéticos.


## Correções da revisão R01/R02

R01: `guardCurrentInboundTools` serializa as tools nativas e MCP de uma inbound
ancorada. Cada execução revalida a mensagem atual; o primeiro descarte arma
`shouldStop` no seam de LLM. O turno espera `drain` antes de limpar MCP e concluir
o job, conservando a lane do contato enquanto qualquer ferramenta está em voo.
Nenhuma ferramenta posterior ao descarte altera o estado, nem no mesmo step.

R02: a recência é reavaliada em `beforeTransport`, depois da assinatura de Storage
e pré-voo, antes de marcar a rede como iniciada. `OutboundSupersededError` encerra
a mensagem preparada como failed/rejected, retryable=false, e o ledger como
vetoed. Um retry dispensado em beforePersist recebe o mesmo desfecho; nenhuma
linha fica queued sem dono. O executor não libera a lane: o turno a conclui.

Provas permanentes: `current-inbound-tools.test.ts` verifica serialização, bloqueio
de mutações nativas/MCP e espera de efeito em andamento. O invariante do turno
cobre chamadas no mesmo step e steps posteriores, parada do modelo, estado
preservado e job concluído. `agent-media-storage.test.ts` cobre texto, imagem,
vídeo e template, descarte terminal antes da rede e ausência de reenvio.
A atividade send_vetoed e a linha failed explicam o descarte nas telas existentes.
Sem nova configuração, credencial, migration ou ativação de disparos.

## Correção da revisão R03 — retry offline superado

Uma resposta já persistida como `queued` pode ter seu retry dispensado antes do
modelo quando chega outra inbound. `discardSupersededOutbound` reconcilia as
intenções do job tanto nessa saída antecipada quanto após a drenagem das tools.
O mesmo statement bloqueia a linha do job pelo owner/workspace/contato/conversa
e cancela somente mensagens `prepared`, sem `external_id`, em `queued`/`failed`:
mensagem `failed/rejected`, `retryable=false`, ledger `vetoed`, motivo
`inbound_superseded`. Uma intenção `requested` sem mensagem também é encerrada.
As identidades e o snapshot do envio são preservados. Confirmações, fases
`started`/`uncertain`, estados legados sem prova e outro owner não são alterados.
Só depois da reconciliação o chamador conclui o job; se ela falhar, não libera
silenciosamente a tarefa como concluída. A atividade `send_vetoed` continua na
timeline e a mensagem terminal deixa de aparecer aguardando envio no Inbox.

Prova: `discard-superseded-outbound.test.ts` cobre SQL real em PGlite, múltiplas
intenções, idempotência, crash pré-persistência, confirmação/incerteza e escopos.
`inbound-retomada-e-midia.test.ts` reproduz reschedule/reclaim após sessão offline,
com nova inbound antes ou durante o modelo, usando o Postgres efêmero oficial.
Sem nova tela, configuração, schema ou envio a cliente real.

## Correção do build E2E — fontes locais

A parte 1 do run `38051912943` falhou antes dos testes: Next.js 16.3.3/Turbopack
não interpretou a URL da IBM Plex Sans recebida do Google Fonts. A parte 2
passou. O diagnóstico foi reproduzido isoladamente com uma resposta sintética
do formato alternativo de URL descrito no bug upstream vercel/next.js#99114;
o log do CI trunca a URL, portanto não preserva a resposta HTTP original.

`app/layout.tsx` e `app/design/lib/fonts.ts` passam a usar `next/font/local`.
`app/fonts/` contém as mesmas famílias, pesos declarados, eixos variáveis,
glifos completos, licenças e manifest com origem fixada e hashes. Nenhum script
de instalação/build baixa fontes. São 11 arquivos WOFF2 para nove famílias;
Atkinson e IBM Plex Mono compartilham os arquivos entre layout e mostruário.
Não há alteração de provider de IA, banco, webhook ou envio de mensagens.

Living System Checklist deste ajuste:

1. Entrada: fontes de `google/fonts`, revisão fixada no manifest, aquisição manual.
2. Saída: módulos dos layouts → `.next/static/media` → imagem → navegador.
3. Registro: manifest/licenças; resultado do build e checks do GitHub Actions.
4. Tela: tipografia existente da interface e do mostruário `/design`.
5. Porta: navegação existente; nenhuma tela nova.
6. Anti-morte: arquivos acompanham o código; build não espera serviço de fontes.
7. Configuração: declarações estáticas dos layouts; sem novo controle de workspace.
8. Continuidade IA↔humano: não se aplica ao empacotamento de fontes, sem mudança no atendimento.
9. Retorno: `fontes-locais.test.ts` reprova import remoto, arquivo ausente/corrompido
   ou hash divergente; build/E2E continuam obrigatórios antes da integração.
10. Mapa: `fontes-locais.architecture.json`, com origem, consumidores e distribuição.

Provas: integridade das fontes e cobertura de português verificadas na aquisição;
teste de regressão e checks existentes. Aprovação do E2E do commit anterior não
é aprovação deste ajuste: a nova execução completa precisa terminar antes do merge.
