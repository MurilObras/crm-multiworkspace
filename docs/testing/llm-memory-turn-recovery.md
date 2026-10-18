# Retomada do fechamento e chave dos auxiliares

## Contrato

- Ler configuração e decidir o ponto antes de decifrar a chave. O provider padrão
  da organização não precisa ter credencial se a chamada escolheu outro provider.
- Uma chave específica exige organização, provider, estado ativo e validação;
  revogação não autoriza substituir pela chave da plataforma.
- `flush` usa a configuração de `compaction` e recebe o mesmo override do agente.
- Depois que as ferramentas terminam, o job guarda
  `turn_closing`: somente referências e configuração, sem transcript ou chave.
- Esse marcador proíbe repetir ferramentas; não comprova entrega. Antes do
  checkpoint e de qualquer saída na retomada, conferir o ledger de todas as
  tentativas sob lease. ACK confirmado reconcilia o ledger; rejeição terminal
  encerra a intenção. Só a inbound superada permite descartar `prepared` sem rede.
- Pendência atual, sem identidade ou incerta impede concluir o job. Não reenviar
  nem voltar às ferramentas; o backoff existente tenta a reconciliação e, se
  esgotado, o aviso `job_dead` pede revisão humana na Central. O descarte seguro
  persiste mesmo quando outra intenção continua incerta.
- Falha de fechamento reexecuta somente o checkpoint. A retomada usa a inbound
  âncora e as mensagens aceitas daquele job; não consome uma pergunta nova.
- Checkpoint já persistido é reaproveitado. A posse da fila é conferida com lock
  antes de gravar. O operador continua deduplicado pelo job de origem.
- Se outro turno já gravou memória mais recente durante o backoff, o fechamento
  atrasado é dispensado: não substitui essa memória nem faz nova chamada de IA.
- Contato removido ou anonimizado não volta a alimentar a memória por retomada.
- Sessão desconectada e cap sem entrega mantêm suas políticas próprias; este
  ajuste não desativa aquecimento, opt-out, handoff ou controle de orçamento.

## Provas de regressão

`compaction.test.ts`, `credentials.test.ts`,
`seam-sem-chave-do-provedor-padrao.test.ts` e
`inbound-fechamento-retomavel.test.ts` cobrem a propagação da chave, ausência da
chave do padrão e retry com banco real sem repetir envio ou nota.

`fechamento-reconcilia-envios-anteriores.test.ts` cobre mensagem preparada por
tentativa anterior, nova inbound, falha de checkpoint, ACK tardio, rejeição
terminal, incerteza, ausência de identidade, lease, isolamento e as saídas por
anonimização/memória recente, sem transporte real.

## Living System Checklist

- Entrada: job em `job_queue`, versão publicada e `ai_purpose_bindings`.
- Saída: `llm_calls`, `lead_checkpoints` e job do operador.
- Log: retomada de fechamento e falhas da fila, sem conteúdo da conversa.
- Tela/porta: IA → Execuções e Central de avisos; atividade no Inbox.
- Configuração: IA → Agentes, Credenciais e Provedores. Sem superfície nova.
- Anti-morte: backoff existente recupera só a memória; esgotamento abre `job_dead`.
- Continuidade: checkpoint/declaracão alimenta o operador e a próxima interação.
- Retorno: um retry reconhece a fase durável, não regenera o atendimento; o próximo
  turno recebe o checkpoint recuperado.
- Mapa: `docs/architecture/agent-turn.workflow.json`, fluxo de fechamento.

## Ordem de execução desta correção

Implementação → revisão/correção até não restarem achados conhecidos → testes
isolados, suíte local e CI/E2E → merge condicionado aos resultados → revisão da
árvore mesclada → publicação/deploy somente se essa revisão passar.

Uma configuração salva e uma revisão sem achados não substituem execução de testes.
