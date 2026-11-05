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
