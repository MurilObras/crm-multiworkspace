# Research — decisões e evidências

## Referências e método

Base CRM `9a2f2808`; Spec Kit `a60bd9bad5af2d25df42188330e8281f2dd1c8bb`. Modelos oficiais e avaliação de bugs lidos; nenhum comando de implementação executado. `AGENTS.md` e `CLAUDE.md` do CRM continuam sendo a autoridade; não criar constituição concorrente.

Evidências brutas somente em `C:/Users/muril/.cache/crm-validation/school-handoffs-audio-20261109/`. Não versionar nem enviar para revisão externa nomes, telefones, áudios, transcrições, credenciais ou dumps reais.

## R01 — Autorização para IA não resolve consulta

**Decision:** vincular resposta explicitamente ao caso e mostrar impedimento ao devolver para automático.
**Rationale:** atribuição e consulta ao coordenador são estados separados; o runtime verifica ambos.
**Alternatives considered:** remover espera indiscriminadamente permite contrariar decisão comercial pendente; fechar caso em qualquer resposta foi rejeitado pelo usuário.

## R02 — Opção confirmada pelo usuário

**Decision:** “Esta resposta resolve a consulta e libera o Júnior”, inicialmente desmarcada. Em outros agentes, nome configurado, sem hardcode de Júnior.
**Rationale:** “vou verificar” não resolve uma dúvida. Escolha acompanha consulta e envio específicos, incluindo áudio.
**Alternatives considered:** fechamento automático indiscriminado e fechamento por nota interna rejeitados.

## R03 — Confirmação real, não bolha otimista

**Decision:** persistir intenção antes do envio e processar efeito por caminho durável após confirmação do transporte.
**Rationale:** HTTP 200 pode devolver mensagem em fila; aba pode fechar depois de enviar. Falha na resolução após transporte não autoriza reenviar a resposta.
**Alternatives considered:** segundo POST apenas no callback do navegador é insuficiente. HTTP em trigger viola a doutrina.

## R04 — Identidade não é campo operacional do agendamento

**Decision:** impedir relink na edição montada para IA e validar vínculo no servidor. Buscar cartão por contato confiável quando necessário.
**Rationale:** audit mostra `contact_id` incorreto e recusa por FK. Não há prova de erro de turma nesse aceite.
**Alternatives considered:** UUID aproximado e relaxamento de FK rejeitados. Administração humana/MCP externo devem preservar relink legítimo com autorização e validação próprias.

## R05 — Pagamento muda finalidade, não a régua comercial

**Decision:** reutilizar cadência publicada e preparar passagem explícita do pós-aula ao pagamento.
**Rationale:** comercial possui seis retornos e aceita aguardando pagamento; pós-aula exige experimental. Inscrição pós-aula observada permanece viva, e só pode existir um fluxo vivo por contato. O comercial anterior foi cancelado manualmente.
**Alternatives considered:** duplicar inscrições, renovar orçamento ou reativar cancelamento humano rejeitados.
**Limite:** snapshot prova incompatibilidade e próxima avaliação prevista, não execução futura perdida. A configuração operacional não será aplicada agora.

## R06 — Separar falha histórica de áudio da atual

**Decision:** validar significado e preparar recuperação do histórico sem resposta automática antes de propor patch novo.
**Rationale:** cinco arquivos alvo falharam em 06/11 por credencial. Pós-atualização há 26 derivações prontas; isso prova processamento, não fidelidade. Aviso ao suporte do contato alvo foi entregue e lido.
**Alternatives considered:** trocar provedor/modelo por tentativa ou afirmar que todo áudio atual continua quebrado rejeitados.
**Classificação complementar:** o único item sem derivação no recorte tem `responsible_internal=true`, mídia persistida e nenhum evento de derivação; pertence ao canal interno do coordenador. Não é evidência de falha em áudio de lead.
**Investigação restante:** validar compreensão de amostra. Não marcar regressão atual antes dessa verificação.

## R07 — Silêncio não é bug confirmado na amostra

**Decision:** preservar contrato e ampliar regressão de concorrência, sem reescrever rota por suspeita.
**Rationale:** 12 encerramentos recentes não criaram turno de resposta nem outbound de IA nos cinco minutos seguintes. `resolved_internal` não enfileira resposta. Isso não exclui acompanhamentos independentes posteriores.

## R08 — Ferramentas solicitadas

- Caveman lido e aplicado à comunicação.
- Superpowers lido para investigação sistemática e evidência antes de conclusões.
- Graphify AST local sem LLM: 6.113 nós e 14.110 relações. Consulta de `devolverAtendimentoAoAgente` mostra autorização, continuidade, checkpoint e auditoria; não substitui teste funcional.
- Plandex existente localizado. Tentativa inicial como usuário padrão falhou; executando como o usuário local `planner`, o acesso existente respondeu. Revisão do planejamento concluída em modo chat, com comandos e aplicação automática desabilitados. Resultado e tratamento dos achados em `analysis.md`; sem compra, recarga ou troca de chave.

## Pendências

Atualização da implementação: há amostra sintética local de áudio do contato de teste em `C:/Users/muril/.cache/crm-validation/experimental-reminder-memory-20261107/entrada-audio-teste.ogg`, fora do Git. Ela pode ser usada numa homologação posterior sem consultar áudios de leads. Os testes locais de credencial/derivação verificam o processamento; não serão apresentados como avaliação semântica real. Nenhum reprocessamento de produção está autorizado nesta execução.

1. Verificar fidelidade semântica em amostra de áudios; classificação do item sem derivação já concluída.
2. Fechar desenho de confirmação de envio após mapear todos os escritores de status; cobrir atribuição concorrente.
3. Reavaliar o planejamento após fechar T002, se a escolha técnica alterar os contratos; revisão Plandex desta versão já concluída. Isso não autoriza implementar.
4. Confirmar contato de teste antes da futura homologação; nunca testar em lead real.
