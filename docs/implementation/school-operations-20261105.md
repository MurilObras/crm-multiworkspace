# Correções operacionais na branch de estabilidade

Escopo aprovado: mesma branch, investigação/implementação, revisão e correção antes dos testes. Sem merge, deploy, PR 20, mudanças no banco real ou mensagens aos leads.

## Critérios de aceite

- Transcrição usa credencial OpenAI independente do provedor de chat; PDF não depende de LLM. Mídia vazia/falha não aparece como interpretada.
- Reprocessamento manual é isolado à derivação, autorizado pelo workspace e pela conversa. Não reabre nem responde a uma mensagem antiga.
- Consulta ao responsável pode ser silenciosa. Encerramento interno fica auditado e não envia mensagem nem reativa opt-out/atendimento humano.
- Falha de áudio pode consultar o responsável conforme opção do agente. Deduplicação por conversa e preservação dos gates de atendimento.
- Follow-up diferencia fila aguardando, transporte confirmado, cancelamento esperado, falha terminal e transporte incerto; nunca avança só por tags ou sucesso do modelo.
- Alertas permitem abrir a origem acessível e distinguem data do evento de situação atual.
- Etiquetas mantêm origem explícita; não sobrescrevem etiquetas particulares do negócio.
- Editor não envia todo o histórico de prompts na abertura; histórico continua acessível sob demanda.

## Trabalho operacional separado

Etiquetar contatos reais, encerrar consultas antigas, conferir agendamentos e publicar uma versão de treinamento são ações posteriores pelas telas. Nenhum nome, telefone, pagamento ou matrícula real será inserido como correção de código. Nenhuma mensagem será enviada nesta implementação.

## Ferramentas

Graphify: mapa de dependências e impactos do worker de mídia e dos callbacks de entrega. Plandex: apoio ao planejamento, sem execução ou aplicação automática. Resposta ausente/timeout não conta como revisão aprovada.

## Verificação

Após fechar a revisão: regressões isoladas de credencial, conteúdo vazio, consulta silenciosa, encerramento concorrente, retry sem resposta antiga, reconciliação de fila/ledger; banco com baseline install/update, isolamento, UI desktop/mobile, typecheck/lint/build e testes de jornadas afetadas. Evidências locais fora do repositório e sem dados reais.

## Contratos operacionais

- `POST /api/v1/messages/:id/reprocess`: papel mínimo agent e visibilidade da mensagem pela sessão; somente mídia recebida, armazenada, não apagada e com falha. Formatos sem extrator são recusados. Uma tarefa de derivação ativa impede outra. O evento não dispara novo turno de resposta. Mutação auditada.
- `POST /api/v1/ai/cases/:id/reply`, ação `resolved_internal`: exige motivo, resolve o caso e registra a decisão sem criar `case_reply_turn`. Guarda NOWAIT impede concorrer com resposta do responsável em trânsito; entrega incerta também bloqueia. Pausas humanas e opt-out não são removidos.
- Configuração de consulta: `notify_client` mantém default true nas configurações antigas; `audio_failures_to_responsible` começa false. As opções são por agente/workspace e não publicam treinamento ou encerram consultas antigas automaticamente.
- `GET /api/v1/ai/agents/:id/versions`: limite padrão 50, máximo 100; cursor `before_version`, resposta com `meta.cursor` e `meta.has_more`. A aba carrega páginas de 20. A versão publicada pelo ponteiro e o rascunho mais recente permanecem na carga inicial mesmo fora da primeira página.
- `fn_followup_reconcile_action`: somente service_role. Exige snapshot CAS e identidade da ocupação. Pending/running aguardam o job sem consumir passos; done com ledgers totalmente accepted pode concluir. Falha com entrega parcial/retida/incerta pausa para conferência. Cancelamentos esperados não viram alertas críticos. Reentrada por janela usa o próprio job; crons legados continuam reconhecidos.

## Sistema vivo

Entrada: opções de consulta e botão Reprocessar no Inbox. Saída: consulta contextual ou texto derivado seguro. Diagnóstico: aviso com origem acessível e estado atual separado da data do evento. Recuperação: nova derivação explícita, encerramento interno auditado e conferência de entrega incerta. Consumo: turno do agente, Central, ficha do negócio e histórico de versões. Mapa: `docs/architecture/operational-media-followups.architecture.json`.

## Limites da regularização

A implementação entrega os controles. Aplicar etiquetas aos atendimentos reais e classificar agendados/aguardando material/retomada/encerrado depende da revisão das conversas pelas telas após a publicação autorizada. Não há classificação automática baseada em nomes nem atualização retroativa de agendamento, pagamento ou presença. A fila de consultas precisa ser encerrada conscientemente; a correção não a libera em lote.

# Revisão após a bateria completa de 06/11

- O cliente HTTP recupera resposta perdida somente nos dois POSTs com contrato
  persistido de idempotência (`messages` e `automation-rules`), com chave explícita,
  três tentativas no máximo e um único orçamento. Timeout, cancelamento, falha de
  body/schema e demais escritas continuam sem repetição automática.
- A jornada E2E de follow-up isola temporariamente outros canais operacionais
  apenas na organização sintética do banco local e restaura os estados no fim.
  A proteção do produto contra remetente ambíguo permanece ativa.
- O teste de reordenação usa quantos cliques forem necessários para chegar ao
  topo, verificando cada movimento. O cenário de último funil isola/restaura os
  outros funis sintéticos em transação. A prova de autoria escolhe etapa de funil
  ativo e usa o DSN local explícito do runner, sem container fixo; guardas testadas
  recusam destinos ausentes ou remotos. As assertivas finais originais permanecem
  obrigatórias.
- A bateria inicial de banco encontrou um timeout no cenário com três ingressos
  de webhook, enquanto outras suítes rodavam. A reprodução e a repetição de banco
  devem ocorrer sem concorrência com build/Playwright, sem aumentar o timeout.

## Resultado da validação local de 06/11/2026

- Vitest: 8.797 casos aprovados e uma falha esperada preexistente, em 797 arquivos,
  considerando a bateria completa e as reexecuções isoladas. Dois hooks de PGlite
  expiraram durante execução concorrente com build; os dois arquivos passaram
  integralmente na repetição com menos concorrência. Os limites não foram ampliados.
- Os 32 casos focados de recuperação idempotente/interface passaram. Os quatro
  testes nativos de importação, inicialização e renderização de PDF também passaram.
- Banco: 1.553 casos aprovados e um skip preexistente, considerando a bateria de
  180 arquivos e a reprodução isolada do único caso que havia expirado. Esse caso
  passou em 10,4 segundos, com o limite original de 30 segundos. INSTALL e UPDATE
  do baseline passaram com ON_ERROR_STOP.
- E2E: matriz local de 96 specs, um worker e zero retries. Parte 1: 156 resultados
  aceitos pelo Playwright, incluindo uma falha esperada preexistente. Parte 2:
  158 aprovados e seis skips. As 18 verificações das jornadas corrigidas também
  passaram antes da repetição completa das duas partes.
- Typecheck, lint, lint:channels, lint:role-rank e build passaram. O lint mantém
  322 avisos preexistentes e nenhum erro. O bundle foi conferido contra o Supabase
  local isolado, com controle positivo do host usado na compilação.
- Plandex concluiu a revisão da recuperação idempotente e da restauração em
  transação. Graphify registrou 19.926 nós/62.130 arestas; o cliente HTTP possui
  159 consumidores mapeados, incluindo testes. As ferramentas não aplicaram código.

### Limites da cobertura

- A cerca de degradação silenciosa já usa test.fail. Nesta execução parou na
  pré-condição de interceptação, portanto não valida o aviso de entrega silenciosa.
  O controle positivo independente de mensagem por WebSocket passou. Não se deve
  contar a cerca como demonstração de que esse aviso funciona.
- Quatro casos do acervo exigem uma chave OpenAI E2E real; dois casos de agenda
  exigem OAuth Google. Permaneceram sem execução, sem uso de chaves de produção.
- Os specs de instalação fresca com WAHA/Redis e de cadastro com confirmação de
  e-mail desligada estão fora da matriz do CI e não foram executados nesta rodada.
  Exigem perfis locais próprios, diferentes do provedor usado pelas demais specs.
- O skip de banco é o rate limit que o próprio arquivo declara coberto no teste
  unitário do fallback. A falha esperada unitária é a separação de histórico da agenda.

### Registro operacional

O QA antigo de autoria apontava para um container fixo e, na primeira bateria,
alterou metadados de autoria/horário da organização sintética e2e-test-org em outro
banco local de testes. O helper passou a exigir o DSN local explícito do runner;
nenhuma escrita foi feita em produção. Os valores anteriores desses metadados
não estavam disponíveis para restauração exata. A matriz final usou apenas o projeto descartável
crm-stability-20261105, API 55421, banco 55422 e app 3106.

O início da bateria foi condicionado à disponibilidade do banco/Auth após reinício
automático do WSL. Evidências, logs e fingerprints estão fora do repositório.
Não houve CI remoto, merge, deploy, alteração no PR 20 ou mensagens a leads reais.
