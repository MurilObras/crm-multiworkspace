# Mídias aprovadas — ampliação do catálogo de agentes

## Escopo e fase

Decisão do usuário em 14/10/2026: recurso geral para todos os workspaces, com
configuração individual. Áudio, foto e vídeo usam o assunto atual; etapa só
restringe disponibilidade. Primeira utilização não exige que o cliente peça
o formato. Repetir o assunto recebe texto. Reenvio exige pedido explícito e
opção habilitada. Sem aviso de gravação prévia ou promessa antecipada de envio.

Esta etapa implementa e revisa código. Testes funcionais, banco, E2E, CI,
merge e publicação estão adiados por instrução do usuário. Revisão estática
não substitui esses testes nem prova entrega real. PR20 não faz parte do escopo.

## Contrato

- `ai_agents.config.approved_media` é o catálogo canônico. Sem essa chave, lê
  `approved_audios` legado. Escritas mantêm a projeção de áudios para leitores
  antigos, no mesmo CAS do JSON completo; não são duas fontes independentes.
- `/api/v1/ai/agents/:id/media`: consulta manager+, mutação admin, organização
  da sessão. `/audios` permanece compatível e só expõe/edita áudio, preservando
  as outras mídias no CAS. Catálogo inválido gera erro visível, sem sobrescrever.
- Limite compartilhado: 20 arquivos por agente, 16 MiB por arquivo. Áudio usa
  conversão Ogg/Opus existente. Foto JPG/PNG e vídeo MP4 H.264/AAC exigem assinatura
  válida e decodificação local limitada por tempo, sem acesso à rede. SVG,
  HTML e playlists não são aprovados. Storage privado com objeto imutável.
- UI `ApprovedAudios` mantém nome interno por compatibilidade, mas aparece como
  **Mídias aprovadas**. Exibe player/visualização de cada formato, gatilho,
  condição, etapas, obrigatório/opcional e **Permitir reenvio a pedido explícito**.
  Cadastro novo começa obrigatório e permite reenvio explícito; registros
  antigos não passam a permitir repetição automaticamente.
- `media_id` identifica foto/vídeo do catálogo; `audio_id` permanece para áudio.
  URL de mídia oficial existente continua suportada. URL não autoriza repetir
  arquivo já entregue pelo catálogo: o pré-voo compara o fingerprint e orienta
  uso da referência aprovada, sujeita às regras de reenvio.
- O assunto usa o classificador existente, modelo/chave/orçamento do agente.
  O plano sob lease e intenções 1/2 permanecem compatíveis com retries antigos.
  Não muda o card apenas para liberar mídia. No máximo uma mídia obrigatória
  por resposta; preferência por texto, humano, opt-out e recência prevalecem.
- Reenvio não é exceção ao ledger: a mesma inbound só pode ser atendida uma
  vez. Pendência/incerteza anterior impede outra cópia, mesmo a pedido. Nova
  inbound explícita permite outra entrega confirmada quando a opção está ligada.
  “Aquele áudio novamente” sem assunto nomeado aponta à última mídia do formato;
  assunto nomeado é resolvido semanticamente. Referência indisponível não vira
  autorização para enviar outro arquivo aleatório.
- Arquivos novos têm fingerprint do conteúdo original e hash de integridade
  do Storage. O fingerprint impede repetição do mesmo arquivo entre agentes
  desta conversa e workspace. Gravações antigas sem fingerprint conservam
  proteção por agente/ID; não se promete comparação retroativa entre arquivos
  que já foram enviados sem identidade de conteúdo. Reaprovação de arquivo não
  deve ser usada como procedimento para contornar a proteção.

## Living System Checklist

1. Entrada: Agentes → Configuração → Mídias aprovadas, API `/media` com RBAC/CAS.
2. Saída: catálogo → audio-rule → requiredAudioPlan → send_message →
   prepareAgentMedia → outbound-attempt → handler/adapter existentes.
3. Registro: api_audit_log nas mutações, decisão/plano no job, referência e
   fingerprint em messages/ledger; vetos/falhas visíveis nas atividades existentes.
4. Tela: prévias/configuração no editor; foto/vídeo/áudio e estado no Inbox.
5. Porta: mesma navegação de Agentes, sem tela órfã ou rota de UI nova.
6. Anti-morte: fila recupera tentativa preparada com identidade original;
   inelegibilidade retorna texto/atividade, sem promessa de envio futuro.
7. Configuração: todas as condições e permissões de reenvio estão no editor.
8. Humano: handoff existente pausa e conserva histórico; mídia não reassume bot.
9. Retorno: entrega/pendência/incer­teza alimentam elegibilidade futura. Administrador
   corrige regra ou desativa arquivo pela tela; não há autoedição do catálogo.
10. Mapa: `docs/architecture/audios-pre-gravados.architecture.json` ampliado.

## Revisão e validação pendente

Preparar e executar posteriormente: arquivos reais dos três formatos, legado,
CAS entre abas, RBAC/isolamento, assunto/etapas, texto, primeira entrega,
pergunta repetida, reenvio ligado/desligado, mesma inbound, tentativa incerta,
troca de agente, URL alternativa, revogação durante assinatura do Storage,
lease perdido e chegada de nova mensagem. E2E valida persistência/preview nas telas.

Falhas anteriores de eco WAHA, links/texto e timeout da tela de testes são
trabalhos separados; esta branch não declara essas correções implementadas.

## Ciclo de revisão desta etapa

- Compatibilidade: preservação dos arquivos anteriores, CAS do catálogo inteiro,
  remoção de aprovações ao duplicar agente e projeção sem campos desconhecidos
  para o schema strict do worker anterior.
- Reenvio: pergunta sem pedido de formato não libera repetição; primeira
  recepção pode ser reenviada a pedido; complemento neutro agrupado preserva
  a solicitação, e preferência posterior por texto prevalece.
- Referência: “aquele arquivo” usa a última mídia do formato, inclusive para
  reconhecer arquivo manual indisponível no catálogo; assunto nomeado não
  é substituído pela última gravação arbitrariamente.
- Entrega: guardas de aprovação/etapa/preferência/repetição no último pré-voo;
  fingerprint bloqueia troca por URL; ledger mantém a mesma intenção no retry.
- Arquivo/UI: assinatura e decodificação antes do upload, MIME/posse coerentes,
  prévias por formato, modo de reenvio visível inclusive sem abrir edição.
- Cobertura preparada: testes de contrato, API, conversa e E2E adicionados ou
  adaptados; a cobertura anterior de URLs foi preservada em arquivo separado.

Checagens estáticas são registradas no commit desta etapa. A execução da suíte
e a prova visual continuam pendentes; não usar esta revisão como aprovação de deploy.
