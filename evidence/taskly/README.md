# Evidências da colorimetria Taskly — 29/10/2026

Fotografia da etapa local sobre a base `710b02e03e5f280eeddf4fa3ac5f45e31c2e24a0`, branch `feat/taskly-colorimetria`. O escopo autorizado troca somente cores por cobalto, gradientes estáticos luminosos e lima contido. Funcionalidades, fontes, medidas, responsividade, marcas de clientes e semânticas permanecem as existentes. [DESIGN.md](../../DESIGN.md) registra os tokens implementados; o [contrato](../../.impeccable/surfaces/app-globals-css.md) e a [régua](../../.impeccable/quality-bar-taskly.md) delimitam o trabalho.

Taskly, Behance 257138265, e as referências locais taskly-17 e taskly-23 em Downloads/Taskly-Referencias-CRM são autoridade de cor, sem autorizar importar layout promocional, lettering ou ilustrações. O plano anterior usou Plandex com contexto Impeccable; os artefatos de planejamento ficam em outputs/taskly-colorimetria no workspace local. Nesta etapa o Codex editou a implementação, sem chamada nova a provedores de IA. Caveman é a voz concisa, não um executor.

## Proveniência e alcance

As capturas são PNGs reais produzidos por Playwright sobre o build local de produção e Supabase pg15 fresco, com conta e dados sintéticos; os manifestos registram dimensões e SHA-256. Diferem do harness sintético histórico de Regulatis. São provas de desenvolvimento, sem novos assets raster servidos ao navegador. Logos, fotos e avatares continuam usando os mecanismos existentes. As folhas de contato são apenas índices visuais derivados e não substituem os PNGs individuais.

O manifesto principal contém 31 PNGs refeitos no build final após F1; confirmações contém oito PNGs de repouso/hover nos dois temas, em 390×900 e 1440×900. O teste habilitou a confirmação pelo nome, fotografou e cancelou, sem executar exclusão. As 13 capturas suplementares de aplicações vêm de cinco testes de UI anteriores a F1: não certificam a correção destrutiva. A captura de settings/templates mostra estado 403, sem validar o formulário. Tokens e componentes compartilhados dão alcance estrutural às 103 páginas com UI entre 112 entradas (nove aliases), sem inspeção visual individual de todas elas. Aparelho físico e transporte WhatsApp não foram testados.

## Índice das capturas

Os caminhos completos a partir da raiz permitem ao gate do repositório relacionar cada imagem à sua finalidade. Consulte os manifestos para dimensões e hashes completos.

### Pacote principal — build final

Manifesto: [manifesto.json](manifesto.json).

| Caminho a partir da raiz | Dimensões | Finalidade e limite |
| --- | --- | --- |
| `evidence/taskly/capturas/cancelada.png` | 1280×720 | Estado após cancelar a citação no cenário integrado; sem envio externo. |
| `evidence/taskly/capturas/cor-dark-1024.png` | 1024×900 | Inbox no tema escuro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-dark-1440.png` | 1440×900 | Inbox no tema escuro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-dark-320.png` | 320×900 | Inbox no tema escuro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-dark-390.png` | 390×900 | Inbox no tema escuro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-dark-430.png` | 430×900 | Inbox no tema escuro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-dark-460.png` | 460×900 | Inbox no tema escuro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-dark-768.png` | 768×900 | Inbox no tema escuro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-ficha-dark-390.png` | 390×900 | Ficha em Sheet no tema escuro; superfície e controles mobile. |
| `evidence/taskly/capturas/cor-ficha-light-390.png` | 390×900 | Ficha em Sheet no tema claro; superfície e controles mobile. |
| `evidence/taskly/capturas/cor-light-1024.png` | 1024×900 | Inbox no tema claro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-light-1440.png` | 1440×900 | Inbox no tema claro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-light-320.png` | 320×900 | Inbox no tema claro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-light-390.png` | 390×900 | Inbox no tema claro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-light-430.png` | 430×900 | Inbox no tema claro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-light-460.png` | 460×900 | Inbox no tema claro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-light-768.png` | 768×900 | Inbox no tema claro; paleta, compositor e composição na largura indicada. |
| `evidence/taskly/capturas/cor-marca-dark-390.png` | 390×900 | Marca sintética amarela no tema escuro; gradiente de ação removido. Não prova todas as marcas ou a origem de instalação no head. |
| `evidence/taskly/capturas/cor-marca-light-390.png` | 390×900 | Marca sintética amarela no tema claro; gradiente de ação removido. Não prova todas as marcas ou a origem de instalação no head. |
| `evidence/taskly/capturas/cor-menu-dark-390.png` | 390×900 | Menu em portal no tema escuro; leitura e enquadramento mobile. |
| `evidence/taskly/capturas/cor-menu-light-390.png` | 390×900 | Menu em portal no tema claro; leitura e enquadramento mobile. |
| `evidence/taskly/capturas/faixa.png` | 1280×720 | Faixa de citação no cenário integrado; não certifica transporte de mensagem. |
| `evidence/taskly/capturas/layout-1024.png` | 1024×900 | Composição do Inbox na largura indicada; apoio à preservação geométrica. |
| `evidence/taskly/capturas/layout-1280.png` | 1280×900 | Composição do Inbox na largura indicada; apoio à preservação geométrica. |
| `evidence/taskly/capturas/layout-1440.png` | 1440×900 | Composição do Inbox na largura indicada; apoio à preservação geométrica. |
| `evidence/taskly/capturas/layout-320.png` | 320×900 | Composição do Inbox na largura indicada; apoio à preservação geométrica. |
| `evidence/taskly/capturas/layout-390.png` | 390×900 | Composição do Inbox na largura indicada; apoio à preservação geométrica. |
| `evidence/taskly/capturas/layout-768.png` | 768×900 | Composição do Inbox na largura indicada; apoio à preservação geométrica. |
| `evidence/taskly/capturas/menu-teclado-1440.png` | 1440×900 | Menu aberto por teclado com foco visível; a versão 1440 foi refeita após estabilizar a lista. |
| `evidence/taskly/capturas/menu-teclado-320.png` | 320×900 | Menu aberto por teclado com foco visível; a versão 1440 foi refeita após estabilizar a lista. |
| `evidence/taskly/capturas/troca.png` | 1280×720 | Estado de troca de conversa no cenário integrado; dados sintéticos. |

### Confirmação destrutiva — correção F1

Manifesto: [confirmacoes/manifesto.json](confirmacoes/manifesto.json). Oito estados com background-image `none`; frente branca no claro e `#0a1020` no escuro. Mínimo medido de 4,6726725:1; hover claro de 4,6920856:1. O veredito também conferiu pixels sólidos e encontrou mínimo aproximado de 4,6394:1. São medidas específicas desses estados, sem certificar todos os pares da aplicação.

| Caminho a partir da raiz | Dimensões | Finalidade |
| --- | --- | --- |
| `evidence/taskly/confirmacoes/destrutivo-dark-1440-hover.png` | 1440×900 | Tema escuro, hover; confirmação habilitada, sem executar exclusão. |
| `evidence/taskly/confirmacoes/destrutivo-dark-1440-repouso.png` | 1440×900 | Tema escuro, repouso; confirmação habilitada, sem executar exclusão. |
| `evidence/taskly/confirmacoes/destrutivo-dark-390-hover.png` | 390×900 | Tema escuro, hover; confirmação habilitada, sem executar exclusão. |
| `evidence/taskly/confirmacoes/destrutivo-dark-390-repouso.png` | 390×900 | Tema escuro, repouso; confirmação habilitada, sem executar exclusão. |
| `evidence/taskly/confirmacoes/destrutivo-light-1440-hover.png` | 1440×900 | Tema claro, hover; confirmação habilitada, sem executar exclusão. |
| `evidence/taskly/confirmacoes/destrutivo-light-1440-repouso.png` | 1440×900 | Tema claro, repouso; confirmação habilitada, sem executar exclusão. |
| `evidence/taskly/confirmacoes/destrutivo-light-390-hover.png` | 390×900 | Tema claro, hover; confirmação habilitada, sem executar exclusão. |
| `evidence/taskly/confirmacoes/destrutivo-light-390-repouso.png` | 390×900 | Tema claro, repouso; confirmação habilitada, sem executar exclusão. |

### Aplicações suplementares — anteriores a F1

Manifesto: [aplicacoes/manifesto.json](aplicacoes/manifesto.json). Não usadas no veredito para certificar a correção F1 nem como cobertura individual das 103 páginas.

| Caminho a partir da raiz | Dimensões | Finalidade e limite |
| --- | --- | --- |
| `evidence/taskly/aplicacoes/tela-habilidades.png` | 1280×888 | Superfície habilidades renderizada pelo teste; anterior a F1. |
| `evidence/taskly/aplicacoes/tela-roteadores.png` | 1280×720 | Superfície roteadores renderizada pelo teste; anterior a F1. |
| `evidence/taskly/aplicacoes/tela-criar-agente.png` | 1280×4300 | Superfície criar agente renderizada pelo teste; anterior a F1. |
| `evidence/taskly/aplicacoes/tela-memoria-da-organizacao.png` | 1280×944 | Superfície memoria da organizacao renderizada pelo teste; anterior a F1. |
| `evidence/taskly/aplicacoes/tela-consumo.png` | 1280×1191 | Superfície consumo renderizada pelo teste; anterior a F1. |
| `evidence/taskly/aplicacoes/tela-caixa-do-humano.png` | 1280×720 | Superfície caixa do humano renderizada pelo teste; anterior a F1. |
| `evidence/taskly/aplicacoes/tela-acervo-de-conhecimento.png` | 1280×720 | Superfície acervo de conhecimento renderizada pelo teste; anterior a F1. |
| `evidence/taskly/aplicacoes/qa-tela-audit.png` | 1280×720 | Superfície de auditoria renderizada; não prova pesquisa por toda ação e conteúdo. |
| `evidence/taskly/aplicacoes/qa-tela-settings-templates.png` | 1280×720 | Estado 403 de settings/templates; prova de renderização do erro, sem certificação do formulário. |
| `evidence/taskly/aplicacoes/qa-tela-templates.png` | 1280×720 | Estado do catálogo/criação de templates capturado pelo teste; anterior a F1. |
| `evidence/taskly/aplicacoes/qa-tela-templates-criando.png` | 1280×720 | Estado do catálogo/criação de templates capturado pelo teste; anterior a F1. |
| `evidence/taskly/aplicacoes/qa-tela-templates-criada.png` | 1280×720 | Estado do catálogo/criação de templates capturado pelo teste; anterior a F1. |
| `evidence/taskly/aplicacoes/pagamento-quantidade-e-configuracao.png` | 1280×1482 | Dashboard comercial renderizado; anterior a F1, sem certificação de cobrança externa. |

### Folhas de contato

| Caminho a partir da raiz | Finalidade |
| --- | --- |
| `evidence/taskly/visao-geral.jpg` | Índice visual derivado das 31 capturas principais; não substitui a abertura individual. |
| `evidence/taskly/confirmacoes/visao-geral.jpg` | Índice dos oito estados destrutivos; não substitui medidas nem veredito. |
| `evidence/taskly/aplicacoes/visao-geral.jpg` | Índice das 13 capturas suplementares anteriores a F1. |

## Medições e compatibilidade

- [medidas.json](medidas.json): sete larguras de 320 a 1440px, dois temas, overflow zero, botão de envio de 44×44 e borda do compositor em y=900 nos casos medidos. Mínimo do gradiente de ação de aproximadamente 5,09:1 no claro e 9,09:1 no escuro; não certifica todos os consumidores.
- [confirmacoes/medidas.json](confirmacoes/medidas.json): oito estados destrutivos, frente real, fundo e contraste composto, todos sem gradiente.
- [geometria-preservada.json](geometria-preservada.json): comparação com a base; 27 declarações globais e 161 do Inbox idênticas, total 188. Não é certificação de toda a UX.
- [detector-inicial.json](detector-inicial.json): único detector executado, preservado. Adições cromáticas autorizadas foram documentadas; avisos de tipografia, raios e bounce são herdados. A borda lateral de 3px do exemplo de citação do laboratório também é anterior e não foi canonizada. Não houve repetição do detector nesta documentação.

A régua gerada de contraste acompanha os sólidos atuais; o algoritmo histórico de derivação das marcas permanece preservado. Seu teste de curva mantém a fixture Sage original, e a seleção padrão mantém o ID legado `sage` por compatibilidade, exibindo Taskly. Manter a curva não promete pixels idênticos em todas as marcas, pois as superfícies da régua mudaram.

## Revisões preservadas

Os três pareceres foram arquivados literalmente em `.txt`, preservando bytes e SHA-256. Nomes `.md` e nomes abreviados de imagens dentro dos textos são registros históricos da emissão; este índice identifica os caminhos entregues. A extensão de arquivo de referência evita interpretar menções históricas como novas citações Markdown, sem alterar conteúdo ou alcance dos pareceres.

| Parecer | Decisão e alcance |
| --- | --- |
| [revisao-local-inicial.txt](revisoes/revisao-local-inicial.txt) | Recapture: captura 1440 feita com skeletons e sem destaque de foco; registro histórico preservado. |
| [revisao-local-completa.txt](revisoes/revisao-local-completa.txt) | Revisão integral após recaptura válida; somente F1 material, gradiente primário cobrindo ação destrutiva; disposition fix. Suas entradas ainda indisponíveis descrevem aquele instante. |
| [veredito-local-f1.txt](revisoes/veredito-local-f1.txt) | F1 resolved, remaining clear e disposition ship somente para a correção; conferiu os 39 PNGs principais/confirmatórios. Não amplia o aceite à superfície inteira, às 103 páginas ou à publicação. |

Não se reescrevem pareceres históricos para fazê-los aprovar o código posterior. O histórico Regulatis permanece em [seu índice](../inbox-regulatis/README.md), separado deste lote cromático.

## Testes e gates — alcance temporal

Resultados locais informados pelo executor, sem reexecução pela documentação:

| Momento | Resultado | Limite |
| --- | --- | --- |
| Antes da última correção F1 | Suíte completa: 786 arquivos, 8724 aprovados e uma falha esperada; Node smoke 4/4. | A suíte completa antecede a última troca de frente destrutiva. |
| Após F1 | Build de produção aprovado; E2E Inbox 4 + confirmação 1 = 5/5; verificações dirigidas 55/55 de régua, marcas e cobertura E2E; lint e typecheck aprovados, com avisos herdados no lint. | Não equivale à suíte completa novamente executada nem ao CI remoto do head final. |
| Capturas suplementares | Cinco testes de UI aprovados, 13 PNGs de aplicações. | Anteriores a F1; settings/templates é 403. |

Na fotografia desta etapa, o segundo ciclo independente no PR, CI obrigatório do head final e publicação ainda eram gates separados pendentes. Publicar exige imagem oficial versionada, backup e rollback. Este documento não é um carimbo de checks externos futuros, e não precisa ser reescrito somente para registrar resultados posteriores se o código da UI permanecer o mesmo.

## Conferência documental desta etapa

O passe documental conferiu as 38 cores entre frontmatter, sidecar e CSS, os onze snippets e suas referências, as oito seções canônicas e a narrativa literal do sidecar. Verificou dimensões e SHA-256 dos 52 PNGs e os hashes LF das fontes registrados nos manifestos. Os links locais dos sete documentos Markdown editados foram resolvidos no disco. Isso verifica consistência documental; não é uma nova revisão visual integral nem execução das jornadas.

O teste existente de evidência citada passou em 45 de 47 casos na primeira execução; os dois casos restantes interpretavam menções abreviadas nos pareceres Markdown como novas citações. Os pareceres foram arquivados literalmente em `.txt`, sem alterar os testes. Depois, o recorte de citações Taskly e ausência de imagens órfãs passou em 2/2, com 43 casos fora do recorte. A execução usou índice Git temporário para incluir este README, sem alterar o staging principal. Não se declara nova execução da suíte completa do produto.
