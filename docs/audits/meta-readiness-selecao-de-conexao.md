# Seleção de conexão outbound — Bloco 3

Auditoria em `feat/meta-official-readiness`, após `22ffae57`.

## Pontos de seleção encontrados

| Ponto | Seleção anterior | Regra após a correção |
|---|---|---|
| `lib/automation/start-conversation.ts:sessaoProntaParaEnvio` | Primeiro WORKING por criação; fallback para qualquer não arquivado | Resolver de `lib/channels/resolve-outbound.ts`; exige único elegível |
| `lib/agent-engine/agent/followup-turn.ts:resolveSendTarget` | Última conversa; sem conversa, primeiro WORKING/mais antigo | Preserva vínculo único; valida sessão vinculada; fallback usa o mesmo seletor puro |
| `lib/followup/enviar-texto-fixo.ts` | Escolhia número da org antes de consultar vínculo do contato | Informa contato ao resolver; não troca conexão vinculada |
| `app/api/v1/contacts/_handler.ts:createContactHandler` | Criação best-effort de conversa no primeiro número | Usa resolver com contato; ambiguidade não cria conversa |
| `lib/messaging/open-shared-contact-conversation.ts` | Sessão explícita validada só por org/id; fallback primeiro número | Valida estado, arquivamento e capability; considera vínculo quando automática |
| `lib/automation/actions/send-whatsapp.ts` e `send-ai-message.ts` | Sessão explícita em config | `ensureConversation` agora valida a sessão com o resolver antes de criar/reabrir |
| `lib/campaigns/worker.ts` | Sessão explícita da campanha, já filtrada por org/WORKING/arquivamento | Mantém remetente explícito; também passa pela validação central de `ensureConversation` |

## Consultas que não escolhem remetente de outbound

- `app/api/v1/campaigns/route.ts` lista **todos** os canais WORKING no GET; o POST
  exige `channel_session_id` e o passa ao RPC. Não escolhe a primeira sessão.
- `app/api/v1/cron/contact-avatars/route.ts` escolhe sessão para consulta de avatar,
  não para envio; `contact-phones` consulta a sessão da conversa.
- `lib/channels/meta/session.ts:metaSessionForOrg` e a rota de onboarding resolvem
  contexto de configuração/tela, não remetente de mensagem.
- Webhooks resolvem sessão por identidade autenticada; mídia, pacing, health,
  watchdog e reconciler consultam sessões vinculadas ou enumeram sessões para
  manutenção. Não fazem fallback de remetente para mensagens novas.
- `sendMessageHandler` mantém a sessão da conversa; os runtimes de IA e MCP
  enviam por esse vínculo. A janela universal segue no sink.

## Contrato central

`selectOutboundSession` é a decisão pura compartilhada entre PostgreSQL e
Supabase. `resolveOutboundSession` faz as leituras escopadas do Supabase.

- Sessão explícita: valida exatamente esse ID, sem fallback.
- Sem sessão explícita: um vínculo 1:1 do contato é preservado. Vínculo arquivado,
  desconectado ou inválido impede envio; não autoriza mudar o remetente.
- Vários vínculos com conexões distintas são ambiguidade e falham fechado.
- Sem vínculo: um único canal elegível resolve; zero ou vários não resolvem.
- Elegibilidade usa `lerEstadoDoCanal`, `capabilitiesOf`, organização e arquivamento.
  Texto é suportado pelos providers conhecidos; template oficial exige a capability
  de definições aprovadas (`requiresTemplates`). Grupos respeitam `groups`.
- `freeformOutsideWindow` não é critério de seleção: nenhuma conexão é escolhida
  para contornar a janela. A verificação permanece no sink, após resolução.
- Não existe preferência/default canônico de número na organização encontrado
  nesta auditoria. Ordem de criação não constitui preferência de negócio.
- Erros de consulta sobem, sem fallback. Apenas ausência da coluna histórica
  `archived_at` usa a tolerância já existente do projeto.

## Evidência e retorno da falha

`lib/channels/resolve-outbound.test.ts` cobre matriz de providers, ambiguidade,
tenant, vínculo e validação de `ensureConversation`. Os testes de follow-up
exercitam o handler PostgreSQL e garantem que um vínculo inválido não busca
alternativas nem paga o turno da IA.

Na automação, a recusa vira o resultado de ação `failed` pelo catch existente.
Na campanha, o worker finaliza a etapa sem envio. No agent-engine, a exceção
segue o orçamento finito da fila. O envio inline mantém o job pendente e registra
o diagnóstico; criação de contato continua best-effort para abrir conversa.
