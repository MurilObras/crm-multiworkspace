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
O replay persistido conserva objeto/identidade. A conversa é reavaliada após o
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
   log do run registra descarte/interrupção sem conteúdo ou telefone.
4. Tela: ficha Proteção de envio confirma retomada ou avisa falha parcial;
   retenções/execuções continuam nas telas já existentes.
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
