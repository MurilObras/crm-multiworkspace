# Áudios pré-gravados — PR #23

## Escopo confirmado

Recurso geral do CRM: biblioteca por agente em todos os workspaces, inclusive
vendas, atendimento e suporte. O administrador anexa, ouve, descreve, aprova,
edita, ativa, desativa e remove gravações pelas telas. Sem TTS, nova chave de
IA, migration, merge ou implantação nesta etapa.

Decisão confirmada pelo usuário em 2026-10-10: o assunto da mensagem atual
é que determina o momento do áudio. A etapa apenas restringe onde pode ser
usado. Se a pergunta for “como funciona?”, o áudio correspondente sai nessa
mesma interação, inclusive quando a etapa avançar durante a resposta. Não
espera outra pergunta e não dispara só porque um cartão mudou de etapa.

## Plano de implementação e comportamento

1. Configuração operacional em `ai_agents.config.approved_audios`, com schema
   central. Campos `trigger_type` (first_contact/topic), `send_when` (condição
   e exemplos), `stage_ids` e `required`. Novo cadastro começa topic/obrigatório;
   o operador pode escolher primeiro atendimento para recepção. Legado sem
   campos de regra usa topic e a descrição use_when como condição; required
   ausente continua false. Alterações valem nos próximos turnos sem republicar.
2. API manager+ para ler e admin para escrever, org da sessão, audit de mutação,
   CAS do JSON completo, etapas ativas do próprio workspace. Edição parcial não
   reseta modo, condição ou etapas. Vínculo arquivado aparece como indisponível
   e pode ser retirado. Duplicação do agente exige aprovação própria de áudio.
3. MP3/M4A/AAC/OGG/WAV/WebM viram Ogg/Opus com ffmpeg já existente. Até 16 MiB
   por arquivo e 20 gravações por agente. Storage privado imutável, sem URL
   assinada persistida. Arquivo inválido falha antes da aprovação.
4. Primeiro atendimento é a primeira resposta da conversa: mensagens iniciais
   agrupadas pelo debounce continuam no mesmo atendimento. Saídas do próprio
   job não o transformam em atendimento posterior durante retry. Tentativas
   failed/rejected, sem ID externo e com retryable=false, não contam como
   atendimento: houve prova de rejeição anterior à rede. Confirmações, filas
   pendentes e incertezas continuam impedindo nova recepção. Para
   assunto, o ponto `audio_intent` usa runModelCall com modelo, provider e
   credencial do agente, sujeito ao painel de provedores e ao orçamento normal.
   O assunto específico tem prioridade mesmo no primeiro contato; recepção é
   fallback quando nenhuma regra de assunto corresponde. É uma chamada auxiliar
   de IA, sem ferramenta mutante: recebe as inbounds ainda sem resposta até a
   âncora atual (até 100 mensagens, em ordem), incluindo transcrições. A ordem
   segue coalesce(sent_at,created_at), created_at e id, como a guarda de recência;
   uma pergunta anterior recebida com atraso continua na interação. A última
   resposta confirmada de outro turno delimita essa interação; saídas deste job
   não alteram a fronteira durante retry. Complementos preservam a pergunta
   pendente; desistências e mudanças explícitas de assunto posteriores prevalecem.
   Recebe esse assunto
   e as regras aprovadas, aceita somente um ID aprovado ou null. Considera
   paráfrases e exclusões; saída inválida degrada para texto. Falha de chamada
   registra atividade; estouro de orçamento mantém o handoff existente.
5. `audio_rule_decision`, inclusive null, persiste no job sob lease ANTES de
   envios. Não reclassifica durante retry nem introduz reserva nova em um job
   antigo que já usou o ledger. `required_audio_plan` conserva ID, agente e fase
   after_response, com intenções 1/2 reservadas. Planos legados conservam suas
   intenções anteriores para recuperação, sem mudar a chave de um envio pendente.
6. O modelo responde e pode atualizar o funil pelos critérios comerciais já
   existentes. Não deve mover cartão só para liberar áudio. O catálogo opcional
   se atualiza no retorno de update_lead_state/crm_move_lead_stage e a ferramenta
   de envio consulta a etapa fresca. Se o Operador cuidar da movimentação depois
   do turno, isso não conta como etapa já alcançada nesta resposta: selecione
   também as etapas em que a pergunta pode surgir, ou Todas as etapas.
7. Depois do modelo, ainda na mesma inbound e antes do checkpoint, o runtime
   reconsulta humano, catálogo, aprovação, etapa e histórico. Texto já confirmado
   é reutilizado como contexto; sem texto, envia uma introdução própria. Resposta
   queued/falha não é seguida de áudio adiantado. Áudio requerido só é invocado
   pelo runtime, evitando que o modelo burle a condição. Resultado real entra
   no fechamento; nunca afirmar entrega sem confirmação.
8. Etapa resolve o negócio aberto mais recente sem empate, ou o encerrado mais
   recente sem empate quando não há aberto. Sem negócio inequívoco, só áudios
   sem vínculo ficam disponíveis. Funil/etapa arquivados não liberam arquivo.
   Se a etapa permitida não for alcançada, o áudio é dispensado com atividade;
   o atendimento segue em texto, sem promessa de entrega futura fora de contexto.
9. Mesma gravação cadastrada no máximo uma vez por conversa. Histórico enviado,
   fila pendente e resultado incerto bloqueiam outra cópia. Texto/áudio como
   preferência explícita persiste na inbound e pode ser alterado pelo cliente.
   Preferências de todas as inbounds agrupadas são reconciliadas em lotes de
   até 100, inclusive no pré-voo, com marcador durável da fonte examinada e CAS
   do corpo e da transcrição. Transcrição tardia ou corrigida é reexaminada;
   preferência derivada obsoleta é substituída. O marcador guarda somente o
   fingerprint da fonte, sem copiar o texto para metadata. A última preferência
   explícita segue a mesma ordem temporal da recência; mensagens neutras
   posteriores não a apagam. Queries e atualizações filtram org/conversa.
   Recência, lease/CAS, opt-out, humano e limites do canal prevalecem. O último
   pré-voo revalida aprovação, etapa, preferência e repetição antes da rede.
10. Retirar plano usa discardPreparedOutbound apenas nas sequências 1/2, sem
    apagar confirmação, incerteza ou resposta normal em seq >=3. Intenções 1/2
    conservam a identidade do ledger e não consomem o teto físico por existirem.
    A contagem de tentativas físicas é separada, incluindo templates e cada
    bolha. Durante a resposta, um envio fica reservado ao áudio; texto confirmado
    serve de contexto. O limite 2 permite texto + áudio, ou só texto quando a
    etapa não permitir áudio. Texto dividido agrupa o excedente no espaço restante,
    sem perder conteúdo; a última guarda confere capacidade antes de cada envio.
    No máximo um obrigatório por resposta. Outros áudios só serão
    considerados se seu assunto aparecer em outra mensagem.
11. Inbox permite anexar áudio pronto e ouvir antes de enviar. Sem legenda em
    áudio: contexto em texto é outra mensagem. Gravações removidas continuam
    privadas no Storage para preservar tentativas em andamento.

## Living System Checklist

1. Entrada: Agentes → editar → Conversador → Áudios pré-gravados; administrador
   aprova arquivo e configura “Quando enviar”, condição/exemplos, etapas e modo.
2. Saída: audio-rule → requiredAudioPlan → send_message → prepareAgentMedia →
   outbound-attempt → handler existente → adapter do canal.
3. Registro: api_audit_log nas edições; llm_calls no classificador; job_queue
   guarda decisão/plano; ledger/messages guardam tentativa e resultado. Vetos
   por inelegibilidade/limite/falha de classificação aparecem em atividades.
4. Tela: biblioteca e prévia no editor; mensagem/status no Inbox; ponto auxiliar
   na configuração de provedores e execuções existentes.
5. Porta: Agentes na navegação; biblioteca na aba Conversador. Inbox → Anexar →
   Áudio pré-gravado. Não cria tela isolada sem entrada.
6. Anti-morte: fila existente recupera envio anterior à rede com o mesmo ledger.
   Incerteza nunca autoriza duplicação; sem áudio elegível, atendimento por texto.
7. Configuração: upload, reprodução, descrição, primeiro atendimento/assunto,
   condição/exemplos, todas/algumas etapas, obrigatório/opcional e ativação na tela.
8. Continuidade IA↔humano: handoff existente prevalece; conversa e gravações ficam
   no Inbox para quem assumir. O agente não reassume por causa de uma regra de áudio.
9. Retorno: resultado real no checkpoint e estado da mensagem; administrador
   ouve, corrige regra ou retira gravação inadequada. Não há autoedição de conteúdo.
10. Mapa: docs/architecture/audios-pre-gravados.architecture.json conecta telas,
    regras de assunto, histórico, etapa, fila, sink e revisão humana.

## Validação e limites

- Segunda revisão (2026-10-10): corrigidas as três falhas de transcrição,
  chegada fora de ordem e recepção após descarte. Regressões exercitam fonte
  tardia/corrigida, CAS concorrente, preservação de metadata, isolamento e
  confirmações/filas/incertezas. Os três comportamentos também passaram no
  turno completo com PostgreSQL efêmero (44 testes em dois arquivos, incluindo
  controles de limite). A suíte direcionada e os mapas passaram; E2E deve
  validar novamente o commit destas correções.

- Revisão final (2026-10-10): corrigidas as três regressões de limite, etapa e
  pergunta seguida de complemento. Os seis cenários originais da revisão passaram;
  com as regressões incorporadas e os controles de teto, 47 testes passaram em
  PostgreSQL efêmero (três arquivos). 204 testes direcionados em 16 arquivos,
  typecheck e lint dos arquivos alterados passaram. A contagem inclui controle
  de texto inteiro, limite 2 com áudio e exclusão de pergunta já respondida.
  O E2E completo precisa rodar novamente no commit destas correções.

- Revisão de rajadas (2026-10-10): os dois casos que falhavam passaram após
  a correção, tanto com SQL embarcado quanto no turno completo em PostgreSQL
  efêmero. 298 testes direcionados em 25 arquivos e 53 testes de banco em
  quatro arquivos passaram. Há controles de preferência posterior, histórico
  acima de 100 mensagens, pré-voo e isolamento por workspace/conversa.
  Typecheck e lint dos arquivos alterados passaram. O E2E deve validar o
  commit atualizado; resultado do commit anterior não o substitui.

- 307 testes direcionados em 15 arquivos passaram: regras/decisão persistida,
  legado, lease/workspace, histórico, upload/CAS, componentes, sink/replay,
  descarte, idiomas, mapas e herança de modelo/chave. Replay offline também
  conserva seq 3 do texto e seq 2 do áudio sem repetir nenhuma mensagem. Typecheck completo e lint sem erros passaram (315 avisos existentes).
- 30 testes de turno/configuração passaram no Postgres efêmero oficial, incluindo
  pergunta atual, paráfrase, preço incompatível, saída inválida, avanço de etapa,
  fora de etapa, aprovação retirada, humano e nova inbound entre texto e áudio.
  O modelo e o transporte desses testes são sintéticos; não medem a precisão de
  um modelo comercial nem a entrega real no WhatsApp.
- Componentes reais conferidos em Edge/Playwright com API simulada: condição e
  modo persistidos, edição/reload para primeiro atendimento, reprodução e layouts
  desktop/celular sem erros de página ou overflow. Evidência fora do repositório.
- A spec E2E audios-pre-gravados.spec.ts usa Supabase local real para upload,
  reprodução do Storage, condição, vínculos, edição do gatilho, reload e remoção.
  Incluída na parte 1 do CI; o novo commit precisa de CI verde antes de merge.
- Conversão real dos seis formatos e nova decodificação já passaram em contêiner
  isolado sem rede na etapa anterior deste PR; arquivo inválido foi rejeitado.

Aprovação humana não transcreve nem verifica conteúdo comercial: descreva
fielmente a gravação. A seleção de assunto é semântica e precisa de calibração
com exemplos reais. A proteção de repetição vale para o ID da gravação cadastrada,
não para arquivos duplicados cadastrados separadamente. Nenhum áudio comercial
foi fornecido; nenhum envio real, merge ou implantação foi feito nesta etapa.
