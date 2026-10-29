# QA visual do atendimento — 29/10/2026

final result: passed

Resultado restrito às sete correções pontuadas no primeiro ciclo e a F1/F2/F3 do segundo ciclo do PR 61. O [veredito final do segundo ciclo](evidence/inbox-regulatis/revisoes/revisao-pr61-veredicto-final.txt) resolveu os três achados com disposition ship limitada ao lote. Este passed não declara aprovação da superfície inteira, CI atual verde, integração geral ou publicação autorizada.

## Fontes duráveis e método

As três referências aprovadas, as 19 capturas da segunda rodada, as nove capturas da terceira rodada, as medições e os pareceres históricos são entregues em [evidence/inbox-regulatis/README.md](evidence/inbox-regulatis/README.md). O índice cita individualmente cada um dos 31 PNGs e explica seu propósito. O contrato continua em [.impeccable/surfaces/components-inbox-inboxlayout-tsx.md](.impeccable/surfaces/components-inbox-inboxlayout-tsx.md).

As comparações da segunda rodada normalizam as referências para 390×844 e 1440×1024, com capturas em CSS pixels e devicePixelRatio 1. Há estados de lista/conversa em 320×844, 390×844, 768×1024 e 1440×1024. As 23 medições entre 320 e 1440px registram zero overflow horizontal e ausência de colisão dos controles medidos do cabeçalho. Essas medidas não demonstram todos os estados, traduções, zoom ou aparelhos.

No arquivamento, o responsável identificou um lote de 24 arquivos cujo payload era JPEG apesar da extensão PNG e normalizou sua codificação para PNG, sem corte, redimensionamento ou alteração dos pixels decodificados. Dimensões foram preservadas. Na prova de área reduzida, foram descartadas uma tentativa com escala física incompatível e outra captura via clip que veio vazia. A prova entregue foi refeita com getScreenshot nativo, na viewport CSS medida em 390×480 e DPR 1, com borda do compositor em 480px conferida antes/depois. O payload nativo foi convertido apenas de codificação JPEG para PNG, sem resize/crop; o arquivo atual mede 390×480 e foi aberto para verificar o conteúdo. Tentativas inválidas não são provas nem constam do índice.

Os componentes de produção foram renderizados num harness Vite local com dados sintéticos e hooks de backend substituídos. A conversa sintética sem dono mostra ações condicionais diferentes do mock atribuído ao usuário; campo vazio mostra microfone e rascunho mostra envio. Não foi inicializado um novo produto, usado raster como UI ou executada a maquinaria formal comp-led de state/spec/hero/final. Não existem seed, score ou aprovação retrospectiva desses gates.

## Fidelidade e preservação

- Atkinson local preservada; campos mobile de 16px e metadados explícitos de 12px. Poppins do mock era condicional e não foi acrescentada.
- Uma, duas ou três regiões pela largura útil do atendimento, nos limiares de 760px e 1100px; a ficha abre em Sheet quando não cabe ao lado.
- Navegação profunda, leitura clara e seleção suave; marca sintética azul conferida no pacote claro/escuro, com precedência dos estilos de instalação e organização.
- Avatar ou iniciais do componente real, ícones do mapa canônico e mecanismos existentes de logo/foto. Nenhuma nova imagem de conteúdo foi incorporada.
- Rótulos, filtros, condições de ações, nota interna, citação, estados de domínio e transporte mantêm suas regras existentes.

## Histórico dos dois ciclos

| Marco | Resultado documentado | Limite |
| --- | --- | --- |
| Revisão local inicial | Sete correções solicitadas; detector único encontrou duas bordas laterais de 2px em citações. | Parecer histórico, anterior às correções. |
| Veredito local após correções | Sete itens resolvidos; disposition ship restrita a esse lote. | Citação foi conferida por fonte; não é aprovação da superfície inteira, de CI ou integração. |
| Revisão integral do PR 61 no head 0125b496 | F1 teclado, F2 contraste de nota e F3 altura/aviso. Disposition fix. | Revisão independente do segundo ciclo, sem herdar aprovação do primeiro. |
| Reavaliação intermediária | F1/F2 resolvidos; F3 parcial por observar somente body com min-height. | A captura anterior do aviso não certificava o cenário com viewport reduzido. |
| Veredito final de F1/F2/F3 | Fonte observa caixas anteriores/ancestrais por ResizeObserver e mudanças childList dos ancestrais por MutationObserver; recapturas completa/reduzida válidas, remaining clear e disposition ship. | Aceite das correções pontuadas; CI do novo head, integração geral, hardware e publicação continuam com seus gates próprios. |

Os relatórios preservados literalmente estão no índice de evidências. A segunda rodada inclui a nota com baixo contraste como registro histórico; as provas finais de nota clara/escura são da terceira rodada.

## Correções da terceira rodada

**F1 — preferências acessíveis.** Idiomas são itens Radix num grupo do menu, sem submenu próprio. Tema é item Radix com ícone e texto do estado atual. Os handlers existentes foram mantidos. `tests/unit/user-menu-teclado.test.tsx` verifica Enter, setas, troca efetiva de tema, Escape e retorno de foco. A matriz de `tests/e2e/inbox-responder-citando.spec.ts` acrescenta foco de teclado no menu em 320px e 1440px; sua presença no código não é prova de execução integrada do lote atual. As capturas da terceira rodada mostram os estados de foco e enquadramento.

**F2 — nota selecionada legível.** O estado usa fundo opaco de `--color-surface`, texto `--color-warning-fg` e contorno fino da mesma tinta. A medição em `evidence/inbox-regulatis/round-3/contraste-nota.json` registra 5,987:1 no tema claro e 8,659:1 no escuro. Estes pares específicos superam 4,5:1; não certificam todos os pares da aplicação.

**F3 — aviso e altura mínima.** A solução body-only foi recusada porque o body com min-height pode manter a mesma altura quando um aviso entra ou sai. A nova solução recompõe as observações de caixas anteriores e ancestrais e observa somente childList nos ancestrais, evitando observar mudanças da subárvore de mensagens. O quinto teste de `tests/unit/inbox-viewport.test.tsx` insere/remove o banner no DOM com body mínimo de 844px e viewport visível de 480px, sem evento artificial de resize; verifica a reserva 440→480px e o mecanismo de notificação.

As recapturas renovadas e `evidence/inbox-regulatis/round-3/medidas-aviso.json` mantêm body mínimo de 844px. Ao inserir/remover aviso sem resize entre os estados, a reserva completa registra 844→804→844px e a reduzida registra 480→440→480px; a borda inferior do compositor permanece em 844px ou 480px, respectivamente. A imagem reduzida é uma captura emulada de 390×480, não teclado/hardware físico. O reviewer reabriu a prova final, conferiu conteúdo/dimensões e resolveu F3 no escopo do lote.

## Testes e CI — alcance temporal

O responsável informou typecheck aprovado no último código, lint com zero erro e 322 avisos, ESLint dos deltas aprovado, 19 testes focais em 3 arquivos e 51 testes de suporte aprovados. O reviewer conferiu o log dos 19 focais. Esses resultados locais não equivalem à suíte completa de Linux do próximo head e não foram reexecutados por esta documentação.

No CI do head anterior `0125b496`, verify terminou com 8720 casos aprovados e uma falha documental: imagens citadas por design-qa não estavam entregues no versionamento. A parte 1 de E2E terminou com 153 aprovados e uma falha de apresentação em queue-assign, que esperava o ordinal isolado em vez do indicador atual com “na fila”; a parte 2 terminou com 160 aprovados e uma falha que esperava Atividade diretamente visível em 1280px, onde a navegação agora usa Ficha. O responsável ajustou somente essas duas asserções de navegação para acompanhar a UI.

O [addendum dos testes integrados](evidence/inbox-regulatis/revisoes/revisao-pr61-testes-integrados.txt) revisou os dois diffs e não encontrou achado material introduzido: a fila consulta o nome acessível do mesmo indicador, e quem manda acessa a ficha por dialog ou coluna conforme a composição, mantendo obrigatórias as provas de Atividade, Assumiu e ausência de fallback. A fonte está apta à nova execução; os dois cenários corrigidos e o restante do CI do novo head ainda precisam passar.

A matriz de layout em seis larguras do cenário `inbox-responder-citando.spec.ts` passou nesse CI com fixtures e banco reais. O responsável abriu as capturas reais de 320px e 1440px. Isso acrescenta prova daquele cenário integrado de layout no head anterior, sem comprovar envio externo, Realtime real ou os deltas posteriores de teclado. Os artefatos brutos ficam fora do Git em `C:/Users/muril/.codex/qa-crm/pr61/0125-parte1/evidencias-responder-citando` e no conjunto `0125-parte2`; as 31 imagens indexadas deste pacote continuam sendo referências e provas do harness sintético.

A verificação local `tests/unit/evidencia-citada.test.ts` aprovou os 44 casos sobre o pacote candidato de documentos e provas, usando um índice Git temporário sem alterar o staging principal. Isso verifica citações e ausência de imagens órfãs no pacote; não é resultado do CI remoto nem valida integração.

O CI também havia reportado `review_required:workspaces-e-acessos` após a alteração de UserMenu. O responsável reavaliou novamente os metadados de `docs/support/catalog.json` e `docs/support/evidence.json`: o fluxo Menu do usuário → Criar workspace → diálogo existente continua o mesmo. Os artigos autorais de suporte não foram alterados por esta documentação. Essa reconciliação de metadados não declara o CI atual aprovado.

## Limites e pendências

As provas visuais usam dados sintéticos e backend substituído; não demonstram entrega de mensagens, APIs, Realtime real, permissões em integração, teclado virtual/hardware físico ou desempenho. Os E2E integrados usam fixtures próprias e banco local; a matriz adicionada não envia mensagens externas.

Antes de integrar/publicar continuam necessários build e testes relevantes sobre o código atual, CI obrigatório do novo head e os gates reais de integração do projeto. O aceite visual dos dois ciclos e a revisão dos dois diffs de testes estão registrados; nenhum resultado do head anterior ou da prévia é transportado automaticamente para o worktree corrigido.
