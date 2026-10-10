# Áudios pré-gravados — implementação no PR #23

Autorizado: anexar gravações na tela do agente, aprová-las e permitir ao Paulo
escolher uma quando útil, com contexto curto enviado em texto separado. Sem
síntese de voz, nova credencial de IA, merge ou publicação nesta etapa.

Ampliação autorizada: recurso geral do CRM, em todos os workspaces, para agentes
de vendas, atendimento ou suporte. Cada gravação pode valer em todas as etapas
ou em etapas específicas dos funis do workspace, selecionadas na própria tela.
Arquivo e regras continuam isolados por workspace/agente.

Decisão do usuário (2026-10-10): switch "Envio obrigatório", ligado por padrão
para novas gravações. Desligado = escolha contextual do agente. Ligado = CRM
envia na primeira resposta elegível ao cliente, dentro das etapas selecionadas,
sem depender de escolha do modelo. Não é disparo proativo ao mover cartão.
Uma gravação nunca é repetida na mesma conversa, inclusive entre turnos,
reentradas na etapa e retries. No máximo um áudio obrigatório por resposta;
outras gravações obrigatórias elegíveis aguardam próximas respostas. Pedidos
de só texto, humano, opt-out, recência, lease e limites de envio prevalecem.
Gravações antigas sem esse campo continuam opcionais; o cadastro novo inicia
obrigatório. O operador pode alterar o modo na tela sem reenviar o arquivo.

Plano adicional: `required` no catálogo existente, POST padrão true e leitura
legada false. Persistir o plano de recepção no payload do job sob lease antes
de qualquer envio, reservando suas duas intenções (contexto e áudio) no replay.
Invocar a mesma ferramenta send_message com todos os guardrails, antes da
decisão do modelo; expor o resultado verdadeiro no contexto do turno. Registrar
preferência de texto nos metadados da inbound e consultar o histórico durável
de messages/approved_audio por conversa. Deduplicação revalidada no último
pré-voo: confirmação, fila pendente ou resultado incerto nunca autorizam outra
tentativa. Tentativa terminal comprovadamente sem transporte pode ser retomada
como nova intenção após a causa cessar. Sem migration, nova credencial ou merge.

Plano da ampliação: `stage_ids` opcional no schema central do catálogo existente;
API valida etapas ativas da organização e expõe opções de seleção; formulário
permite criar/editar vínculos; turno filtra o catálogo pelo negócio atual do
contato e revalida imediatamente antes da rede. Sem negócio identificável ou
com empate, áudio vinculado não é elegível. Preferir negócio aberto mais recente
(resolvedor existente); se não houver aberto, usar o encerrado mais recente sem
empate, permitindo áudios em etapas ganhas/perdidas. Etapas/funis arquivados não
liberam gravações. Arquivos anteriores sem `stage_ids` valem em qualquer etapa.
Validar isolamento entre workspaces, etapa inválida/arquivada, mudança durante
preparação, persistência dos vínculos pela tela e regressão da biblioteca.

## Plano

1. Biblioteca por agente no `ai_agents.config.approved_audios`, configuração
   operacional como os knobs de RAG existentes. Não altera schema nem versões.
   Upload/ativação/desativação têm efeito no próximo turno, explicitado na tela.
2. API autenticada: leitura manager+, escrita admin, organização da sessão,
   arquivo privado e imutável; atualização por CAS do JSON completo para evitar
   perda de alterações concorrentes. Duplicação começa sem áudios aprovados.
3. Converter MP3/M4A/AAC/OGG/WAV/WebM para Ogg/Opus no upload (ffmpeg já acompanha
   a imagem do app). Arquivo inválido/conversão indisponível falha visivelmente,
   sem cadastrar algo que o canal não consegue enviar. Teto 16 MiB/arquivo e
   20 gravações/agente, limites de recurso, não regras comerciais.
4. Modelo recebe somente ID/título/quando usar dos opcionais. `send_message` aceita ID de áudio,
   nunca caminho privado ou URL do lead. Aprovação revalidada na preparação e
   imediatamente antes do transporte. Copiar para o Storage da conversa e usar
   o mesmo ledger, lease, guardrails e veto de inbound obsoleto já existentes.
5. Inbox: anexar áudio pronto, ouvir antes de enviar e não oferecer legenda
   para áudio. Texto de contexto é mensagem própria, com as guardas normais.
6. Validar upload, isolamento, CAS, revogação, transporte/replay e fluxo visual;
   integrar testes ao CI. Arquivo de teste não vai para contatos reais.

## Living System Checklist

1. Entrada: administrador na edição do agente aprova arquivo e finalidade.
2. Saída: catálogo do turno → send_message → prepareAgentMedia → sink existente.
3. Registro: audit ai_agent.updated nas alterações; ledger/messages no envio.
4. Tela: biblioteca no AgentForm e áudio/status na timeline existente do inbox.
5. Porta: Agentes → editar → Conversador; Inbox → Anexar → Áudio pré-gravado.
6. Anti-morte: fila existente recupera falhas anteriores à rede; resultado
   incerto não autoriza duplicação. Sem áudio aprovado, conversa segue em texto.
7. Configuração: cadastro, prévia, ativação, envio obrigatório/opcional e seleção de etapas na biblioteca;
   opções da própria organização no GET (meta.stage_options); IDs de outro
   workspace ou de etapas/funis arquivados recusados na escrita. Vínculo cuja
   etapa foi arquivada fica visível como indisponível e pode ser removido.
8. Continuidade: áudio fica na mesma conversa disponível ao humano; atendimento
   humano e retomada da IA seguem os gates existentes.
9. Retorno: falha volta à ferramenta e ao estado da mensagem; administrador pode
   ouvir/desativar gravação inadequada, retirada dos turnos seguintes. Não há
   autoedição de áudio. `eligibleAudiosForContact` filtra o catálogo no turno;
   `assertAudioStillApproved` revalida aprovação e etapa antes do transporte.
   Veto por etapa encerra mensagem/ledger e retorna instrução de seguir por texto.
   `requiredAudioPlan` grava o plano no job sob lease; `deliverRequiredAudio`
   invoca send_message antes do modelo com contexto sem split e reserva duas
   intenções estáveis. Retry retoma a mesma dupla. Retirada do plano usa o CAS
   de `discardPreparedOutbound` só nas sequências 1 e 2, preservando confirmações,
   incertezas e respostas normais. Catálogo e último pré-voo consultam o histórico
   durável; pending/confirmed/uncertain bloqueiam outra cópia. Preferência de texto
   fica em metadata.agent_audio_preference da inbound e vale para turnos seguintes.
   Limite menor que duas mensagens gera atividade visível de áudio obrigatório
   pendente; nunca se ultrapassa o limite. Configuração não dispara mensagem só
   por movimentar cartão nem interfere em follow-ups determinísticos existentes.
   Gravações removidas não são apagadas imediatamente do
   Storage para preservar tentativas em andamento; permanecem privadas.
10. Mapa: audios-pre-gravados.architecture.json conecta editor, catálogo e sink.

Limites: aprovação humana não transcreve nem verifica o conteúdo comercial da
gravação. Informe uma descrição fiel. Não enviar áudio quando o cliente pedir
texto; não repetir a mesma gravação cadastrada já enviada na conversa.
Sem arquivo real fornecido, validar com gravação sintética em ambiente isolado.

## Evidências e limites da validação

- Testes unitários do upload manual/catálogo: normalização antes de guardar,
  organização da sessão, papel, CAS concorrente, leitura e edição de metadados.
- Sink com PostgreSQL embarcado: aprovação fresca antes da rede, isolamento,
  origem preservada no retry offline, descarte por inbound nova e replay único.
  Preferência explícita distingue pedidos de só texto de pedidos de áudio,
  inclusive “prefiro áudio, não texto”; perguntas sobre os meios disponíveis
  não gravam bloqueio. Uma autorização posterior substitui a preferência anterior.
- Postgres efêmero oficial: turno completo recebe catálogo sem caminho privado,
  exige contexto em texto, recusa ID inventado/repetição e retoma em texto após
  retirada de aprovação. Também preserva os cenários anteriores de fila.
  Ampliação por etapas e modo obrigatório: 21 testes de turno/configuração
  passaram no banco isolado, incluindo envio sem escolha do modelo, modo
  opcional, texto, histórico já enviado, limite de mensagens e novo turno.
  Áudio fora da etapa não é oferecido ao modelo; mudança de etapa
  durante a assinatura do arquivo veta o transporte e encerra a tentativa.
- Conversão REAL com ffmpeg da imagem existente: WAV, MP3, M4A, AAC, OGG e WebM
  gerados sinteticamente → Ogg/Opus → nova decodificação bem-sucedida. Arquivo
  inválido rejeitado. Contêiner de teste sem rede; nenhum serviço reiniciado.
- Edge/Playwright: componentes reais com API simulada, aprovação/edição/
  desativação/reload, reprodução, file picker do Inbox e preview sem legenda;
  desktop e celular sem erro de página nem overflow horizontal. Isto verifica
  a interface, não substitui a spec E2E contra Supabase local.
- `audios-pre-gravados.spec.ts` faz upload pela tela real, reprodução do arquivo
  retornado do Storage, vínculo de etapa, edição para todas as etapas,
  recarregamento, modo obrigatório padrão/alteração persistente para opcional,
  desativação persistente e remoção; incluída na parte 1 do CI.
  O novo commit precisa de CI verde antes do merge.

Sem merge, implantação, áudio de cliente ou envio real de WhatsApp nesta etapa.
Para uso comercial, o operador deverá anexar e aprovar suas gravações reais.
