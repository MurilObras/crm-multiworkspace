# Estabilização de seleção, resposta e entrega de mídia

Escopo congelado na branch `fix/media-delivery-stabilization`, sobre `v3.9.1`.
O baseline de homologação tinha sete fechamentos corretos, uma seleção de áudio
nula e uma negativa textual seguida de áudio obrigatório. Não atribuir essas
falhas ao PR de memória sem uma comparação entre revisões.

## Contrato

- Referência explícita e unívoca ao título do catálogo ativo pode resolver o item
  sem LLM. Identificar não autoriza: etapa, repetição, hash, aprovação, recência,
  humano, lease e entrega pendente/incerta continuam no mesmo caminho de envio.
- Conteúdo/assunto é diferente de disponibilidade. Instruções de repetição não
  devem fazer o classificador esquecer o assunto de um pedido claro de reenvio.
- O contexto de uma mídia autorizada é conferido antes de virar snapshot/envio.
  Negativas incompatíveis e afirmações antecipadas são contidas localmente, sem
  outra chamada paga. Outro parágrafo factual é preservado; se nada restar, usa
  contexto neutro. A retomada não reescreve partes que já foram aprovadas.
- A reserva por assunto não garante envio na etapa atual. Um avanço legítimo
  durante o turno pode habilitar o arquivo; contexto e transporte consultam a
  etapa e a aprovação atuais. Se a aprovação foi retirada ou o limite impede
  montar o plano obrigatório, não apagar uma negativa que continua verdadeira.
- O ensaio usa a mesma resolução e contenção, mas continua mostrando `planned`,
  sem arquivo realmente enviado ou sucesso de entrega inventado.
- Ausência de seleção não é falha de transporte. Entrega anterior não significa
  proibição permanente, e negativa antiga do agente não é preferência do cliente.

## Manifesto fixo

As linhas abaixo são cenários-base, não uma alegação de contagem de testes. Os
subcasos declarados nos arquivos são enumerados pelo runner. Congelar esta matriz
antes de executar; não ampliar com ajustes de estilo durante a homologação.

| ID | Cenário e resultado | Prova executável |
|---|---|---|
| F01 | Pedido longo de reenvio de áudio, com vídeo/foto negados: um áudio | `media-reference.test.ts`, `test-conversation.test.ts` |
| F02 | Pedido curto e histórico de negativa: contexto coerente + arquivo | mesmos, `response-resume-turn.test.ts` (três formatos) |
| F03 | Primeiro assunto correspondente: apresentação uma vez | `audio-rule.test.ts`, `test-conversation.test.ts` |
| F04 | Assunto repetido após entrega: texto | `contextual-media-intent.test.ts`, `conversation-audios.test.ts` |
| F05 | Pedido de formato sem repetição clara: não duplicar | mesmos, `media-reference.test.ts` |
| F06 | Só texto nesta resposta expira no próximo pedido | `contextual-media-intent.test.ts` |
| F07 | Preferência geral + exceção temporária não perde a regra geral | mesmo, `test-conversation.test.ts` |
| F08 | Visual específico no primeiro contato vence recepção | `audio-rule.test.ts` |
| F09 | Demonstração: primeira, assunto repetido, replay | `contextual-media-intent.test.ts`, `test-conversation.test.ts` |
| F10 | Despesa: selecionar o item específico sem apresentação concorrente | `audio-rule.test.ts`, `test-conversation.test.ts` |
| F11 | Lembretes: item específico e intenção de repetição | `media-reference.test.ts`, `contextual-media-intent.test.ts` |
| F12 | Foto: primeira, assunto repetido, replay | `contextual-media-intent.test.ts`, `test-conversation.test.ts` |
| F13 | Registrar gastos por áudio não pede gravação | `media-reference.test.ts`, `test-conversation.test.ts` |
| F14 | Dois títulos plausíveis: nenhuma escolha arbitrária | `media-reference.test.ts` |
| S01 | Reenvio desligado: veto | `media-reference.test.ts`, `conversation-audios.test.ts` |
| S02 | Aprovação revogada: sem rede | `contextual-media-intent.test.ts`, testes de outbound |
| S03 | Etapa não permitida/alterada: sem deslocar card para enviar | `audio-stage-eligibility.test.ts`, `test-conversation.test.ts` |
| S04 | Nova inbound durante envio: descartar resposta antiga | `response-resume-turn.test.ts`, testes de outbound |
| S05 | Humano/consulta/recusa: respeitar pausa | `response-resume-turn.test.ts`, invariantes de handoff/responsáveis |
| S06 | Offline: retomar mesma intenção segura, sem duplicar contexto | `response-resume-turn.test.ts` |
| S07 | Entrega incerta não cria outra cópia | `media-reference.test.ts`, `contextual-media-intent.test.ts` |
| S08 | Mesmo job/inbound e alias de conteúdo: deduplicação | `contextual-media-intent.test.ts`, `response-resume-turn.test.ts` |
| S09 | Contato/workspace distintos: nenhuma prova atravessa escopo | `contextual-media-intent.test.ts`, testes de outbound |
| S10 | Memória única; falha transitória só retoma fechamento | `response-resume-turn.test.ts`, `checkpoint-call.test.ts` |
| P01 | Menos I/O e chamadas auxiliares para referência explícita | `contextual-media-intent.test.ts`, `test-conversation.test.ts` |
| P02 | Otimização não conserva autorização depois da revogação | `contextual-media-intent.test.ts` |
| P03 | Preparação/codec e conversão externa não são inferência | ensaio isolado de mídia + diagnóstico abaixo |
| P04 | Comparação pareada de I/O antes/depois, sem somar fases aninhadas | benchmark isolado e tempos por fase |

## Desempenho e limites

Referência real anterior: primeiro texto 55–78 s; vídeos 100–146 s até terminar
a tentativa confirmada. Vídeos gastaram 21–28 s só no adapter e aproximadamente
6–7 s na preparação. Não usar ACK atualizado depois como relógio de primeira entrega.

O caminho novo evita carregar três preferências quando só um formato é relevante,
dispensa filtros antecipados que eram refeitos depois da classificação e elimina
classificação paga para título explícito inequívoco. A negativa atual, a prova do
job, o histórico de pendência e o pré-voo continuam consultados no momento devido.
Não há cache global, redução do agrupamento de 8 s ou aumento de polling.

`inbound_dispatch_timing` mede os efeitos pós-entrada e `dispatch_processing_timing`
mede o processamento do evento. São durações limitadas com IDs internos e nomes
de fase, sem conteúdo, telefone, URL ou chave. Somá-las a `event_age_ms` duplicaria
intervalos. O tempo do conversador inclui suas ferramentas e transportes.

O transporte atual pede conversão ao WAHA. Retirar conversão exige comprovar
codec, voz/reprodução e envio em canal isolado; um `ffprobe` não comprova isso.
Sem essa prova, preservar conversão e registrar o limite. Não transformar o
benchmark com I/O controlado em promessa de latência real de WhatsApp.

## Sequência e parada

Implementação -> revisão/correção estática -> checagens locais -> banco isolado ->
provedor sintético limitado -> CI e ambas as partes E2E -> revisão posterior.
Falhas provocam correção e repetição do conjunto afetado; não reduzir a suíte.
Meta de desempenho proposta: 20% menos mediana na parcela controlada antes do
transporte, em comparação pareada. Sem evidência, essa meta fica pendente.

## Evidência isolada em 27/10/2026

- Regressão focada: 163 casos aprovados, em cinco arquivos. Inclui as duas
  frases reais, títulos concorrentes e uma negativa deliberada do modelo.
  A revisão posterior também corrigiu a distinção entre negativa do agente e
  descrição válida de funcionalidades por texto, coberta por dois controles.
  A variação de F01 com “não reenviar vídeo” foi reproduzida antes da correção:
  perdia `repeat` e virava `show`. Agora a recusa de outro formato é separada do
  pedido positivo, com e sem vírgula; recusa posterior do próprio formato veta
  o arquivo. O probe anterior e o posterior mantêm o mesmo pedido sintético.
- O banco isolado detectou uma regressão na reserva antecipada de etapa, antes
  da entrega: o cenário existente de avanço legítimo deixou de receber áudio.
  A correção conserva a reserva e revalida a elegibilidade antes do contexto;
  `inbound-retomada-e-midia.test.ts` também cobre negativa após avanço, aprovação
  retirada e limite insuficiente. O check de banco precisa passar novamente.
- Provedor real: três chamadas sintéticas no mesmo modelo publicado, HTTP 200:
  pedido longo com outros formatos negados, demonstração visual espontânea e
  contexto com histórico de negativa. Dois classificadores e uma chamada à
  ferramenta de contexto; nenhuma entrega WhatsApp ou escrita no CRM. Credencial
  mantida no servidor por relay efêmero que aceita só os três corpos aprovados.
  Isso é smoke limitado, não prova estatística nem substituto do banco/E2E.
- Benchmark pareado de `availableConversationAudios`, sete pares, alternando a
  ordem, mesmo catálogo e PGlite com 8 ms controlados por consulta:
  baseline `a78ae288` = 14 consultas, mediana 220,72 ms; alteração = 4 consultas,
  mediana 62,64 ms. Redução de 71,62% **nesta função**. Não mede o turno inteiro,
  o banco remoto, o transporte nem um SLA de WhatsApp.
- Áudio e três vídeos fornecidos: decodificação local sem erro. Vídeos H.264,
  1080x1920; o áudio é legível pelo decodificador. Não foi realizado envio WAHA
  sem conversão: a conversão atual permanece habilitada.
- Lint do código versionado sem erros; 322 avisos existentes. Os auxiliares
  particulares ignorados pelo Git foram excluídos da varredura local; o CI roda
  o comando integral em clone limpo. Typecheck e gates externos são conferidos
  separadamente no PR, sem apresentar testes não executados como aprovados.

Merge, deploy e teste real posterior dependem de autorização específica. Após
publicação, até três rodadas fixas com o contato autorizado, buscando duas
consecutivas aprovadas. Primeira interação em ambiente isolado; histórico real
preservado. Risco de envio a outro contato ou de quebrar pausa interrompe a rodada.

## Ativação comercial após publicação autorizada

Somente no workspace solicitado, revisar a condição da apresentação: identificar
o assunto de funcionamento e o formato pedido; permissões de reenvio ficam nos
controles próprios. Conferir versão salva. Não gravar nomes, planos ou IDs do
negócio no runtime genérico e não alterar configuração dos outros workspaces.

Living System Checklist: entrada em `inbound-turn`, saída no ledger/adapter e
checkpoint; diagnóstico na tela existente de Execuções/Testes; negativa contida
antes da rede; falha retorna à matriz fixa e às guardas de envio; nenhuma tela,
coluna ou tabela nova. PR 20 fora do escopo.
