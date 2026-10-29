# Evidências do Inbox Regulatis — 29/10/2026

Este diretório entrega as referências aprovadas e as provas citadas em [design-qa.md](../../design-qa.md). O índice usa caminhos completos relativos à raiz do repositório para que o gate de evidência consiga relacionar cada imagem à sua finalidade.

As referências foram copiadas do conjunto local aprovado em Downloads/Regulatis-Referencias-CRM/propostas-inbox. São material de comparação de desenvolvimento; não foram incorporadas à interface. As capturas renderizam componentes reais do CRM num harness local com dados sintéticos e hooks de backend substituídos. Elas não comprovam integração, envio, Realtime de produção, hardware, teclado virtual físico ou desempenho.

O arquivamento normalizou para codificação PNG um lote de 24 arquivos que continham payload JPEG com extensão PNG, preservando dimensões e pixels decodificados, sem corte ou redimensionamento. Para a área reduzida, uma tentativa em escala física e outra captura via clip vazia foram descartadas. O arquivo entregue veio de getScreenshot nativo na viewport CSS medida em 390×480 e DPR 1, com borda do compositor em 480px conferida antes/depois. O payload JPEG nativo foi convertido para PNG sem resize/crop; arquivo e conteúdo foram abertos e conferidos em 390×480. São medidas de emulação, não de teclado físico; tentativas inválidas não entram no índice.

## Imagens e finalidade

| Caminho a partir da raiz | Finalidade e alcance |
| --- | --- |
| `evidence/inbox-regulatis/referencias/04-combinacao-fila-controles.png` | Referência aprovada da lista: estrutura profunda, busca, filtros e fila. |
| `evidence/inbox-regulatis/referencias/05-conversa-mobile.png` | Referência aprovada da conversa mobile: identidade, ações, histórico e compositor. |
| `evidence/inbox-regulatis/referencias/06-atendimento-desktop.png` | Referência aprovada da composição desktop: navegação, lista, conversa e ficha. |
| `evidence/inbox-regulatis/round-2/comparacao-lista.png` | Comparação pareada de referência e lista implementada. |
| `evidence/inbox-regulatis/round-2/comparacao-conversa.png` | Comparação pareada da conversa mobile. |
| `evidence/inbox-regulatis/round-2/comparacao-desktop.png` | Comparação pareada do atendimento desktop. |
| `evidence/inbox-regulatis/round-2/lista-320.png` | Lista em 320px; reflow dos controles e abas. |
| `evidence/inbox-regulatis/round-2/lista-390.png` | Lista em 390px; primeiras conversas e hierarquia de leitura. |
| `evidence/inbox-regulatis/round-2/lista-768.png` | Lista em 768px; busca compacta no shell sem colisão. |
| `evidence/inbox-regulatis/round-2/lista-1440.png` | Lista e estado sem seleção no desktop. |
| `evidence/inbox-regulatis/round-2/conversa-320.png` | Conversa em 320px; ações e compositor em uma região. |
| `evidence/inbox-regulatis/round-2/conversa-390.png` | Conversa em 390px; avatares e mensagem enviada de marca. |
| `evidence/inbox-regulatis/round-2/conversa-768.png` | Conversa em 768px de janela; composição pelo espaço útil restante. |
| `evidence/inbox-regulatis/round-2/conversa-1440.png` | Atendimento desktop da segunda rodada com ficha. |
| `evidence/inbox-regulatis/round-2/desktop-escuro.png` | Composição desktop com o tema escuro. |
| `evidence/inbox-regulatis/round-2/ficha-mobile-claro.png` | Ficha em Sheet no tema claro. |
| `evidence/inbox-regulatis/round-2/ficha-mobile-escuro.png` | Ficha em Sheet no tema escuro. |
| `evidence/inbox-regulatis/round-2/menu-mobile-escuro.png` | Aparência do menu escuro na segunda rodada; anterior à correção de teclado do ciclo do PR. |
| `evidence/inbox-regulatis/round-2/marca-azul-claro.png` | Marca sintética azul no tema claro; fallback violeta não se sobrepõe. |
| `evidence/inbox-regulatis/round-2/marca-azul-escuro.png` | Marca sintética azul no tema escuro. |
| `evidence/inbox-regulatis/round-2/toolbar-mobile-foco.png` | Estado de foco e tratamento profundo da toolbar mobile. |
| `evidence/inbox-regulatis/round-2/nota-mobile.png` | Estado histórico da nota antes da correção de contraste F2; não é a aparência final aprovada. |
| `evidence/inbox-regulatis/round-3/menu-teclado-claro.png` | Menu claro com foco de teclado na opção de tema. |
| `evidence/inbox-regulatis/round-3/menu-teclado-escuro.png` | Menu escuro com foco de teclado na opção de tema. |
| `evidence/inbox-regulatis/round-3/menu-320.png` | Menu em 320px com o primeiro idioma focado e opções no enquadramento. |
| `evidence/inbox-regulatis/round-3/menu-1440.png` | Menu em 1440px com o primeiro idioma focado e opções no enquadramento. |
| `evidence/inbox-regulatis/round-3/nota-claro.png` | Nota selecionada no tema claro, depois da correção de contraste. |
| `evidence/inbox-regulatis/round-3/nota-escuro.png` | Nota selecionada no tema escuro, depois da correção de contraste. |
| `evidence/inbox-regulatis/round-3/aviso-mobile.png` | Composição com aviso acima do shell; deve ser lida junto à medição e ao alcance do parecer final. |
| `evidence/inbox-regulatis/round-3/aviso-area-reduzida.png` | Recaptura com body mínimo real de 844px e área visível emulada de 480px; não é ensaio de teclado físico. |
| `evidence/inbox-regulatis/round-3/conversa-1440.png` | Estado desktop após as correções do segundo ciclo. |

A segunda rodada conserva o histórico avaliado no primeiro ciclo. Os estados de menu e nota dessa rodada não substituem as provas posteriores da terceira rodada. Não interpretar uma captura antiga de defeito como o estado final do código.

## Medições

| Arquivo | O que registra |
| --- | --- |
| `evidence/inbox-regulatis/round-2/medidas-limites.json` | 23 larguras do harness, com retângulos dos controles, largura útil e verificação de colisão/overflow. Não é execução de integração. |
| `evidence/inbox-regulatis/round-3/contraste-nota.json` | Par efetivamente composto da nota selecionada: 5,987:1 no claro e 8,659:1 no escuro. |
| `evidence/inbox-regulatis/round-3/medidas-aviso.json` | Body mínimo mantido em 844px; reserva completa 844→804→844px e reduzida 480→440→480px ao inserir/remover aviso sem resize entre os estados. A borda do compositor permanece em 844px ou 480px, respectivamente. É emulação no harness, aceita no parecer final restrito a F1/F2/F3. |

## Pareceres preservados

As cópias `.txt` abaixo mantêm literalmente os bytes dos relatórios Markdown locais ignorados pelo Git. Nomes de imagens dentro desses relatos pertencem ao pacote histórico que cada reviewer recebeu; o índice acima é a relação de PNGs efetivamente entregue aqui. Não se reescreve um parecer antigo para fazê-lo aprovar o código novo.

| Arquivo | Decisão e alcance histórico |
| --- | --- |
| `evidence/inbox-regulatis/revisoes/revisao-local-inicial.txt` | Primeiro ciclo: fix, sete correções solicitadas. |
| `evidence/inbox-regulatis/revisoes/revisao-local-veredicto.txt` | Primeiro ciclo: ship limitado às sete correções pontuadas, sem aprovar integração ou publicação. |
| `evidence/inbox-regulatis/revisoes/revisao-pr61-inicial.txt` | Segundo ciclo, diff integral do PR 61 no head 0125b496: fix, achados F1/F2/F3. |
| `evidence/inbox-regulatis/revisoes/revisao-pr61-intermediaria.txt` | Reavaliação do lote: F1/F2 resolvidos; F3 parcial, pois body-only não garante restauração com min-height. |
| `evidence/inbox-regulatis/revisoes/revisao-pr61-veredicto-final.txt` | Veredito final: F1/F2/F3 resolvidos, remaining clear e ship limitado ao lote corrigido. |
| `evidence/inbox-regulatis/revisoes/revisao-pr61-testes-integrados.txt` | Addendum dos dois diffs E2E: nenhuma regressão material de fonte identificada; cenários corrigidos ainda dependem da nova execução. |
| `evidence/inbox-regulatis/revisoes/detector-inicial.json` | Saída histórica do detector único: duas citações com borda lateral de 2px, depois reduzidas no código. Não é detector novo. |

Checksums SHA-256 das cópias históricas:

- `revisao-local-inicial.txt`: `b821aa3b48a21f40dda9fbb057a7184ae6ce750f9f801737dcab77232ec6285f`
- `revisao-local-veredicto.txt`: `9085f2fd502629075c561c89717775a4ab2a511dd7a14a5f0e08efb26f5688c3`
- `revisao-pr61-inicial.txt`: `fe390a1bca26f4a2ede132452bf58beb04ab1c62fa5c4b8e60fffa79124d4d6a`
- `revisao-pr61-intermediaria.txt`: `7ac92a756af9a21e91c1120899767cd25fd6fd024b524a58963e368aab7e6dc8`
- `detector-inicial.json`: `97194e58f3e939d3685a701537d7c1c636a33bc093241a3c013d53ba38178f21`
- `revisao-pr61-veredicto-final.txt`: `cb8716119c8f058caf66125b2933565befb4708abde0d8545297c12e30b99e3f`
- `revisao-pr61-testes-integrados.txt`: `aadd1a1d1071232573bbca2fb0a7ce73a4b64d742d3fd2fcd88c54f6bb796e61`

## Estado de aceitação

O parecer final resolveu F1/F2/F3. A correção de F3 observa caixas anteriores/ancestrais com ResizeObserver e mudanças childList dos ancestrais com MutationObserver, sem observar a subárvore das mensagens. As recapturas completa/reduzida e as medições foram renovadas com o mínimo real do body; o reviewer reabriu o arquivo reduzido atual e conferiu conteúdo/dimensões. O ship cobre os achados pontuados nos dois ciclos, sem aprovação global da superfície.

Os resultados Linux do head anterior não validam automaticamente o worktree corrigido. O CI anterior falhou na entrega documental de imagens e em duas asserções de apresentação dos E2E; a matriz de layout com fixtures/banco reais passou naquele head. Os dois diffs de testes foram revisados sem achado material e estão aptos à nova execução. CI atual, integração geral e hardware continuam com seus gates próprios. Este índice não autoriza merge ou publicação.
