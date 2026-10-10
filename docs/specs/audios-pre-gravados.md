# Áudios pré-gravados — implementação no PR #23

Autorizado: anexar gravações na tela do agente, aprová-las e permitir ao Paulo
escolher uma quando útil, com contexto curto enviado em texto separado. Sem
síntese de voz, nova credencial de IA, merge ou publicação nesta etapa.

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
4. Modelo recebe somente ID/título/quando usar. `send_message` aceita ID de áudio,
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
7. Configuração: cadastro, prévia e ativação na biblioteca; falhas exibidas ali.
8. Continuidade: áudio fica na mesma conversa disponível ao humano; atendimento
   humano e retomada da IA seguem os gates existentes.
9. Retorno: falha volta à ferramenta e ao estado da mensagem; administrador pode
   ouvir/desativar gravação inadequada, retirada dos turnos seguintes. Não há
   autoedição de áudio. Gravações removidas não são apagadas imediatamente do
   Storage para preservar tentativas em andamento; permanecem privadas.
10. Mapa: audios-pre-gravados.architecture.json conecta editor, catálogo e sink.

Limites: aprovação humana não transcreve nem verifica o conteúdo comercial da
gravação. Informe uma descrição fiel. Não enviar áudio quando o cliente pedir
texto; não repetir gravação já enviada na conversa sem necessidade explícita.
Sem arquivo real fornecido, validar com gravação sintética em ambiente isolado.

## Evidências e limites da validação

- Testes unitários do upload manual/catálogo: normalização antes de guardar,
  organização da sessão, papel, CAS concorrente, leitura e edição de metadados.
- Sink com PostgreSQL embarcado: aprovação fresca antes da rede, isolamento,
  origem preservada no retry offline, descarte por inbound nova e replay único.
- Postgres efêmero oficial: turno completo recebe catálogo sem caminho privado,
  exige contexto em texto, recusa ID inventado/repetição e retoma em texto após
  retirada de aprovação. Também preserva os cenários anteriores de fila.
- Conversão REAL com ffmpeg da imagem existente: WAV, MP3, M4A, AAC, OGG e WebM
  gerados sinteticamente → Ogg/Opus → nova decodificação bem-sucedida. Arquivo
  inválido rejeitado. Contêiner de teste sem rede; nenhum serviço reiniciado.
- Edge/Playwright: componentes reais com API simulada, aprovação/edição/
  desativação/reload, reprodução, file picker do Inbox e preview sem legenda;
  desktop e celular sem erro de página nem overflow horizontal. Isto verifica
  a interface, não substitui a spec E2E contra Supabase local.
- `audios-pre-gravados.spec.ts` faz upload pela tela real, reprodução do arquivo
  retornado do Storage, recarregamento, desativação persistente e remoção; incluída
  na parte 1 do CI. O novo commit precisa de CI verde antes do merge.

Sem merge, implantação, áudio de cliente ou envio real de WhatsApp nesta etapa.
Para uso comercial, o operador deverá anexar e aprovar suas gravações reais.
