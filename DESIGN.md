---
name: "CRM — colorimetria Taskly"
description: "Cobalto luminoso, leitura clara e lima contido nos componentes existentes."
colors:
  chrome: "#1643c0"
  chrome-text: "#ffffff"
  chrome-muted: "#f0f4ff"
  chrome-hover: "#2437ba"
  chrome-focus: "#ffffff"
  chrome-border: "#a7bcff"
  highlight: "#d7f65b"
  highlight-foreground: "#1d2911"
  canvas: "#f7f9fd"
  surface: "#ffffff"
  surface-elevated: "#edf2ff"
  text: "#1b2334"
  text-muted: "#566174"
  text-subtle: "#59677f"
  border: "#dce3f1"
  control-border: "#76839b"
  accent: "#3047e8"
  accent-foreground: "#ffffff"
  accent-soft: "#e8eeff"
  selected-row: "#e8eeff"
  accent-hover: "#2437ba"
  canvas-dark: "#111827"
  surface-dark: "#192337"
  surface-elevated-dark: "#24324b"
  text-dark: "#f0f4ff"
  text-muted-dark: "#bdc9df"
  text-subtle-dark: "#a8b6ce"
  border-dark: "#34445f"
  control-border-dark: "#71829f"
  accent-dark: "#a7bcff"
  accent-foreground-dark: "#121c34"
  accent-soft-dark: "rgba(167, 188, 255, 0.16)"
  selected-row-dark: "rgba(167, 188, 255, 0.16)"
  accent-hover-dark: "#cbd7ff"
  error: "#a94a3c"
  destructive-foreground: "#ffffff"
  error-dark: "#c87263"
  destructive-foreground-dark: "#0a1020"
typography:
  title:
    fontFamily: 'var(--font-atkinson), ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.25
  identity:
    fontFamily: 'var(--font-atkinson), ui-sans-serif, system-ui, sans-serif'
    fontSize: "16px"
    fontWeight: 600
  body:
    fontFamily: 'var(--font-atkinson), ui-sans-serif, system-ui, sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  body-compact:
    fontFamily: 'var(--font-atkinson), ui-sans-serif, system-ui, sans-serif'
    fontSize: "14px"
    fontWeight: 400
  preview:
    fontFamily: 'var(--font-atkinson), ui-sans-serif, system-ui, sans-serif'
    fontSize: "13px"
    fontWeight: 400
  label:
    fontFamily: 'var(--font-atkinson), ui-sans-serif, system-ui, sans-serif'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: "16px"
rounded:
  primitive: "4px"
  navigation: "8px"
  control: "10px"
  field: "12px"
  avatar: "14px"
  bubble: "16px"
  full: "9999px"
spacing:
  space-1: "4px"
  space-2: "8px"
  space-3: "12px"
  space-4: "16px"
  space-5: "20px"
  space-6: "24px"
  space-8: "32px"
components:
  button-send:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    rounded: "{rounded.field}"
    width: "44px"
    height: "44px"
  button-action-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    rounded: "{rounded.primitive}"
    typography: "{typography.label}"
    padding: "0 10px"
  button-action-outline:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.primitive}"
    typography: "{typography.label}"
    padding: "0 10px"
  button-action-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.primitive}"
    typography: "{typography.label}"
    padding: "0 8px"
  input-search:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    typography: "{typography.body}"
    padding: "8px 16px 8px 36px"
  navigation-current:
    backgroundColor: "{colors.highlight}"
    textColor: "{colors.highlight-foreground}"
    rounded: "{rounded.navigation}"
    typography: "{typography.body-compact}"
    padding: "4px 12px"
  scope-selected:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    rounded: "{rounded.control}"
    typography: "{typography.label}"
    padding: "8px 6px"
  conversation-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    padding: "16px"
  conversation-row-selected:
    backgroundColor: "{colors.selected-row}"
    textColor: "{colors.text}"
    padding: "16px"
  contact-container:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    padding: "16px"
  composer-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    typography: "{typography.body}"
    padding: "8px 12px"
  note-mode-selected:
    backgroundColor: "{colors.surface}"
    textColor: "var(--color-warning-fg)"
    rounded: "{rounded.control}"
    typography: "{typography.label}"
    padding: "8px 12px"
  button-destructive:
    backgroundColor: "{colors.error}"
    textColor: "{colors.destructive-foreground}"
    rounded: "{rounded.primitive}"
---

# Design System: CRM — colorimetria Taskly

## Overview

**Creative North Star: "Cobalto luminoso, leitura clara"**

A navegação usa cobalto e gradiente estático luminoso; o trabalho acontece sobre superfícies frias de leitura, com seleção suave e texto legível. O lima destaca poucas seleções da navegação. No tema escuro, os neutros azulados e as frentes claras são desenhados separadamente.

Este documento mescla a mudança cromática global autorizada em 29/10/2026 com os padrões implementados do Inbox. A autoridade de cores é Taskly, Behance 257138265; composição, funcionalidades, Atkinson, medidas e responsividade permanecem as existentes. O [contrato cromático](.impeccable/surfaces/app-globals-css.md) substitui o violeta anterior somente em cor. Os padrões de layout abaixo continuam específicos do Inbox; não prescrevem três painéis para outras jornadas. A marca por instalação e organização e as semânticas de estado continuam soberanas. A documentação descreve o build local, sem declarar CI final ou publicação.

**Key Characteristics:**

- Cobalto com gradientes estáticos separados dos tokens de cor sólida.
- Superfícies frias e lima contido; marca resolvida prevalece sobre o padrão.
- Componentes reais, controles explícitos e ícones do mapa canônico.
- Composição determinada pela largura útil do atendimento.

## Colors

A paleta padrão é global: cobalto nas ações e na navegação, brancos frios no conteúdo e lima em seleções contidas. Os aliases do Inbox consomem os mesmos papéis; não existe fallback violeta próprio da rota.

### Primary

- **Cobalto de ação** (`accent`, `accent-hover`, `accent-foreground`): ação primária, contagens, foco e mensagem enviada no celular.
- **Azul de seleção** (`accent-soft`, `selected-row`): abas, avatares de fallback e linha selecionada; os dois papéis agora resolvem ao mesmo token suave.
- **Cobalto de navegação** (`chrome`, `chrome-text`, `chrome-muted`): fundo sólido, texto e apoio do cabeçalho e sidebar, com gradiente em camada própria.
- **Interação no cobalto** (`chrome-hover`, `chrome-focus`, `chrome-border`): hover, foco claro e contornos sobre a navegação.
- **Destaque no escuro** (`accent-dark`, `accent-foreground-dark`, `accent-soft-dark`, `selected-row-dark`, `accent-hover-dark`): papéis alternativos do fallback quando `html[data-theme="dark"]` está ativo.

### Secondary

- **Lima contido** (`highlight`, `highlight-foreground`): item atual da sidebar e filtro mobile selecionado. Não substitui o verde de sucesso nem os papéis semânticos. Sob marca personalizada, esses papéis passam à seleção suave e à tinta da marca.

### Neutral

- **Tela fria e painéis claros** (`canvas`, `surface`, `surface-elevated`): histórico, lista, ficha e faixas de controles.
- **Tinta e texto de apoio** (`text`, `text-muted`, `text-subtle`): leitura principal, horários, fila e metadados.
- **Divisória e contorno funcional** (`border`, `control-border`): separação de regiões e contorno mais forte de campos e controles.
- **Neutros do tema escuro** (`canvas-dark`, `surface-dark`, `surface-elevated-dark`, `text-dark`, `text-muted-dark`, `border-dark`, `control-border-dark`): substituem os papéis claros; não se obtêm invertendo a tela.

O sidecar registra as onze paradas reais do cobalto e dos neutros, sem sintetizar novas rampas. `app/globals.css` é a fonte dos papéis e `app/design/lib/tokens.ts` mantém os sólidos equivalentes no laboratório. A opção padrão do laboratório conserva o ID legado `sage` por compatibilidade e exibe o nome Taskly. A curva de marcas em `lib/branding/rampa.ts` permanece histórica: sua fixture Sage original não foi recalibrada para esta paleta. A régua gerada de contraste acompanha os novos sólidos; isso não promete pixels idênticos para toda marca cadastrada.

**The Marca Soberana Rule.** A marca resolvida por instalação ou organização prevalece sobre o padrão Taskly. A guarda no documento cobre `#marca-instalacao` no head e `#marca-organizacao` no body; remove os gradientes de ação e ambiente, deriva o chrome da marca e substitui o lima pelos papéis da marca. Nunca copiar o padrão por cima da marca resolvida.

**The Cor Sólida Rule.** Texto, borda, foco, aliases e régua consomem cores válidas. Gradientes estáticos vivem somente em background-image: chrome e ação claros usam `linear-gradient(115deg in srgb, #1643c0 0%, #3047e8 52%, #5362da 100%)`; ação escura usa `linear-gradient(115deg, #a7bcff, #cbd7ff 52%, #b5c1ff)`. O ambiente do shell usa `linear-gradient(135deg, #edf2ff 0%, #fafbff 70%, #f1f7e1 100%)` no claro e `linear-gradient(135deg, #192337, #111827 70%, #182525)` no escuro. Não converter esses fundos em valores de tokens sólidos.

**The Semântica Soberana Rule.** Erro, sucesso, aviso, informação, trilhas de pessoas da agenda e categorias conservam seus papéis. Ação destrutiva usa vermelho sem gradiente em repouso e hover, com frente semântica própria; lima não significa sucesso. O alias destrutivo escuro usa `destructive-foreground-dark`, sem alterar os vermelhos.

## Typography

**Body Font:** Atkinson Hyperlegible, carregada localmente em `app/layout.tsx`, com a pilha de fallback existente. Há arquivos locais de peso regular e negrito; os pesos intermediários solicitados pelo CSS não correspondem a arquivos novos adicionados neste redesign.

**Character:** leitura de operação, sem fonte de exibição nova. A direção Poppins dos mockups era condicionada a avaliação; a implementação preserva Atkinson.

### Hierarchy

- **Title**: título da lista, papel `title`.
- **Identity**: nome do contato no cabeçalho e linha da lista mobile, papel `identity`; o nome da lista usa peso médio ou seminegrito conforme não lidos.
- **Body**: campos e compositor usam o papel `body`. O balão mobile define esse tamanho; os parágrafos de mensagem ainda usam a entrelinha mais curta `leading-snug` herdada do componente.
- **Body compact**: a partir do container de duas colunas, nomes da lista e balões passam ao tamanho `body-compact`; a prévia usa `preview`.
- **Label**: abas, fila, horários e metadados legíveis. A ficha usa títulos de seção no tamanho compacto, com peso seminegrito.

Selos da lista, excedente de tags, remetente IA e horários de mensagem aplicam `text-xs` diretamente nos componentes. O responsável da conversa usa OwnerBadge sem o modo compacto; as iniciais decorativas ficam ocultas da árvore acessível. Não depender de seletores `data-slot` ausentes nos componentes compartilhados para estabelecer esses tamanhos.

**The Texto Operável Rule.** Preservar campos mobile no tamanho do papel `body`, metadados de atendimento com o mínimo aprovado de 12px e rótulos explícitos nas ações. Valores menores nas iniciais decorativas não estabelecem uma escala de leitura.

## Layout

A fonte do layout é `components/inbox/inbox-workspace.css`. O container `inbox / inline-size` é a área útil depois de descontar a navegação, não a largura total da janela.

- **Abaixo de 760px úteis:** uma região principal. Sem seleção, lista; com seleção, conversa. A barra da conversa mantém “Conversas” e “Ficha”. O topo de filtros e o cabeçalho da conversa usam a estrutura profunda.
- **De 760px até menos de 1100px úteis:** lista de 300px e conversa no espaço restante. A ficha continua em Sheet. A lista e a conversa ficam visíveis independentemente da seleção.
- **A partir de 1100px úteis:** lista de 320px, conversa flexível e ficha de 300px; o acesso duplicado à ficha deixa de aparecer.
- O cabeçalho global tem container próprio `shell-bar`: abaixo de 760px úteis, a busca vira botão de 44px e as preferências inline saem daquela faixa. A regra que oculta o cabeçalho global durante uma conversa mobile usa viewport menor que 760px, explicitamente diferente do container do Inbox.
- O shell reserva `100dvh`, ou `--inbox-viewport-height` atualizado pelo visual viewport quando disponível. O hook também observa caixas anteriores e ancestrais com ResizeObserver e recompõe essas observações por mudanças childList nos ancestrais, sem observar a subárvore das mensagens. Isso permite recalcular o offset quando avisos entram/saem mesmo que o body mantenha sua altura mínima; o mecanismo não depende só de resize do body. Lista e histórico têm suas áreas de rolagem. O compositor respeita `safe-area-inset-bottom`.
- O ritmo reutiliza os passos `space-1` a `space-8` do frontmatter. Linhas usam mínimo de 92px no mobile e 84px nas composições de múltiplos painéis. No desktop, o padding da linha é 14px por 12px.
- Busca, filtros, abas, ações principais, modos do compositor e ações da ficha recebem mínimo de 44px no código desta superfície. Isso é uma meta aplicada a esses grupos, não prova de que todos os controles herdados de dialogs e ferramentas já cumprem o alvo.

**The Largura Útil Rule.** Escolher a composição pelo espaço real do atendimento; não antecipar três painéis porque a janela passou de um breakpoint global.

## Elevation & Depth

O caráter é predominantemente plano: diferenças de tom e bordas separam navegação, lista, histórico e ficha. A aba ativa remove a sombra. O Inbox conserva a sombra pequena dos balões e a sombra mínima dos botões primários existentes; o Sheet herda a sombra de sobreposição da biblioteca. Os valores exatos, por tema, estão no sidecar, extraídos de `app/globals.css`.

**The Profundidade Funcional Rule.** Usar a profundidade existente para distinguir balão, controle e sobreposição. Não introduzir sombra dura deslocada ou animação ornamental como sinal de qualidade do atendimento.

Os botões comuns herdam a transição rápida e a curva de saída do sistema. A sidebar conserva transição de largura. As classes de animação herdadas do Sheet não demonstram, por si, uma animação executada; não são uma nova gramática de movimento confirmada.

## Shapes

Controles de toque têm curvas suaves, com os papéis `control` e `field`. O avatar de contato usa o papel `avatar`; o avatar da mensagem recebida tem 32px de lado e curva de 10px. Balões usam o papel `bubble` e reduzem a curva do canto junto à origem da mensagem. Botões genéricos conservam a curva menor do componente comum; a navegação usa a curva intermediária. Contagens e selos permanecem pílulas.

A ficha é uma coluna de seções com identidade e ações; não transformar cada seção em um novo cartão elevado. As citações devem manter autor, trecho e cancelamento dentro da hierarquia existente; a borda lateral de destaque encontrada na revisão inicial não é canonizada como dispositivo deste sistema.

## Components

### Buttons

Ações diretas, com rótulos legíveis. “Assumir” usa a variante primária; ações de atendimento usam outline ou ghost conforme o componente existente. A barra quebra em linhas com espaçamento de 8px, sem esconder ações para reproduzir um estado incidental do mockup. O envio usa o quadrado de 44px descrito no frontmatter. Ativo e desabilitado continuam herdados de `components/ui/button.tsx`; o CSS da superfície adapta hover e foco ao contexto.

Primária/default e envio usam o sólido de ação sob o gradiente estático; hover remove a imagem e usa o sólido de hover. A variante destrutiva remove explicitamente background-image e conserva vermelho em hover, com brilho de 95%. A confirmação de apagar dados do tenant conserva sua sobrescrita vermelha com opacidade de 90% em hover, também sem imagem. Sob marca personalizada, ação não recebe gradiente. Os tokens de componente do frontmatter descrevem a base sólida; os snippets do sidecar incluem a imagem e os estados. As oito [medidas de confirmação](evidence/taskly/confirmacoes/medidas.json) registram mínimo de 4,67267:1 para a frente real; o [veredito F1](evidence/taskly/revisoes/veredito-local-f1.txt) tem aceite restrito a essa correção.

Na toolbar da conversa abaixo de 760px úteis, hover usa `chrome-hover` e mantém `chrome-text`; foco visível usa `chrome-focus`, contorno de 2px e offset interno de -3px. Na composição intermediária, a toolbar é clara e hover usa `accent-soft` com `accent`. Essa barra fica oculta na composição de três regiões. Botões e links da ficha mantêm mínimo de 44px.

### Chips

Abas indicam o escopo e conservam a semântica Tabs. A seleção tem superfície suave, texto de destaque e contagem preenchida; as abas podem quebrar de linha. “Não lidos” continua um botão de alternância com `aria-pressed`. Filtros de canal e tags só existem quando seus dados e condições atuais os habilitam. Selos de status e responsável não viram menus por causa de setas do mockup.

### Cards / Containers

A lista tem fundo de painel; o histórico usa a tela fria; a ficha reúne identidade, tags, demandas, leads, pedidos e atividade já existentes. O container da ficha usa padding de 16px e intervalo de 20px entre grupos. Nas menores larguras, o mesmo componente ocupa o Sheet, sem uma versão funcional divergente.

### Inputs / Fields

A busca tem curva do papel `field`, contorno funcional e tamanho de texto mobile. Em uma coluna, recebe fundo escuro próprio para continuar dentro do chrome; nas composições largas, retorna ao painel claro. O compositor mantém campo de no mínimo 56px de altura, crescimento limitado e botão de envio ao lado. Hover, foco, erro e desabilitado permanecem os estados dos componentes reais.

### Navigation

O shell continua usando o registro de navegação, nomes, ícones e permissões existentes. Cabeçalho e sidebar compartilham o cobalto com gradiente; o item atual recebe lima e tinta escura no padrão, e seleção derivada sob marca personalizada. Os demais usam texto claro de apoio. A sidebar existente ocupa 240px expandida ou 64px recolhida, com ícones do mapa canônico em `lib/ui/icons.ts`. A biblioteca primária da feature é Phosphor via esse mapa; componentes compartilhados legados não são permissão para novos imports diretos.

As preferências que saem da faixa inline continuam acessíveis no Menu do usuário. Idiomas são itens Radix num grupo nomeado, sem submenu próprio; Tema é item Radix com ícone e texto do estado atual. Participam da mesma coleção de foco por setas, Enter e Escape, com retorno de foco ao gatilho; não usar botões avulsos dentro do menu para essas preferências.

### Conversa e compositor

Mensagens recebidas têm avatar de contato ou iniciais, quando a identidade está disponível. No mobile, as enviadas usam ação de marca com frente correspondente; nas composições a partir de 760px úteis, usam superfície suave com texto de leitura. Manter nota interna, falha, mídia, citação, revogação e edição como estados existentes, sem normalizá-los em um balão genérico.

“Responder” e “Nota interna” permanecem modos distintos. A ferramenta de áudio aparece no estado sem texto; envio aparece conforme rascunho e modo. Anexos, emoji, sugestões, bloqueios e atalhos mantêm seus handlers e condições. Uma captura com rascunho do mockup não autoriza alterar essa lógica.

Nota selecionada usa o papel `note-mode-selected`: superfície opaca, texto `--color-warning-fg` e contorno interno de 1px na mesma tinta. A tinta semântica acompanha o tema existente. As medidas Regulatis em [contraste-nota.json](evidence/inbox-regulatis/round-3/contraste-nota.json) são históricas e antecedem a troca das superfícies; não são certificação de contraste da paleta Taskly.

## Do's and Don'ts

### Do:

- **Do** respeitar a precedência da marca resolvida e a troca de tema.
- **Do** manter gradientes estáticos separados dos sólidos e vermelho sem gradiente nas ações destrutivas.
- **Do** medir a largura útil do Inbox antes de escolher uma, duas ou três regiões.
- **Do** manter ações, estados e permissões existentes ao traduzir as referências aprovadas.
- **Do** usar os ícones do mapa canônico e componentes reais.
- **Do** conferir foco, contraste, quebra de texto e controles alcançáveis nos estados mobile e desktop.

### Don't:

- **Don't** restaurar o fallback violeta anterior ou importar a composição Taskly como parte de uma mudança de cores.
- **Don't** importar uma imagem de tela como interface ou acrescentar imagens de conteúdo ausentes do produto.
- **Don't** criar menus, funcionalidades ou regras de negócio a partir de detalhes incidentais dos mockups.
- **Don't** converter texto pequeno, colisões ou bordas decorativas apontadas pela revisão em regras para futuras telas.
- **Don't** tratar capturas do harness histórico como comprovação de backend, ou os E2E locais Taskly como prova de envio WhatsApp, Realtime de produção ou aparelho físico.
