---
name: "CRM — sistema visual do Inbox"
description: "Navegação profunda, leitura clara e seleção suave no atendimento existente."
colors:
  chrome: "color-mix(in srgb, var(--color-brand, #6d28d9) 24%, #100b21)"
  chrome-text: "#faf7ff"
  chrome-muted: "#ddd2f1"
  chrome-hover: "#34264c"
  chrome-focus: "#e2ceff"
  canvas: "#fbfaff"
  surface: "#ffffff"
  surface-elevated: "#f3f0fa"
  text: "#1f1533"
  text-muted: "#625a75"
  border: "#e8e1f3"
  control-border: "#9a87b2"
  accent: "#6d28d9"
  accent-foreground: "#ffffff"
  accent-soft: "#ede9fe"
  selected-row: "#f5f2ff"
  accent-hover: "#5b21b6"
  canvas-dark: "#16121f"
  surface-dark: "#1c1728"
  surface-elevated-dark: "#2b233b"
  text-dark: "#f5efff"
  text-muted-dark: "#c4b8d8"
  border-dark: "#3b304c"
  control-border-dark: "#8d7aa8"
  accent-dark: "#c4a5ff"
  accent-foreground-dark: "#201039"
  accent-soft-dark: "#35234d"
  selected-row-dark: "#2c203c"
  accent-hover-dark: "#d4bfff"
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
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
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
---

# Design System: CRM — Inbox

## Overview

**Creative North Star: "Navegação profunda, leitura clara"**

A estrutura de navegação usa uma faixa escura e contínua; o trabalho acontece em painéis claros, com seleção suave e texto legível. A hierarquia serve ao atendimento frequente no celular: localizar uma conversa, reconhecer quem está no comando e escrever sem perder o contexto do contato.

Este documento registra o código do redesign do Inbox, ainda sujeito à revisão e aos gates descritos no [contrato da superfície](.impeccable/surfaces/components-inbox-inboxlayout-tsx.md). Não estabelece uma nova identidade para todo o CRM. A personalização por instalação e organização, os temas e os componentes existentes continuam sendo a autoridade do produto. As cores de destaque acima descrevem o fallback do Inbox sem folha de marca; as cores escuras descrevem seu tema escuro.

**Key Characteristics:**

- Navegação profunda e leitura em superfícies claras.
- Seleção lavanda no padrão, derivada da marca quando há personalização.
- Componentes reais, controles explícitos e ícones do mapa canônico.
- Composição determinada pela largura útil do atendimento.

## Colors

A paleta do Inbox combina estrutura violeta profunda, brancos frios e uma seleção lavanda; os papéis de destaque continuam ligados aos tokens resolvidos da marca.

### Primary

- **Destaque violeta** (`accent`, `accent-hover`, `accent-foreground`): ação primária, contagens, foco e mensagem enviada no celular.
- **Lavanda de seleção** (`accent-soft`, `selected-row`): aba ativa, item de navegação ativo, avatares de fallback e linha selecionada. Os dois papéis têm intensidades distintas no código.
- **Estrutura profunda** (`chrome`, `chrome-text`, `chrome-muted`): cabeçalho e navegação. O fundo é a expressão de mistura preservada no frontmatter, alimentada por `--color-brand`, e não o hex fixo proposto no mockup.
- **Interação na estrutura profunda** (`chrome-hover`, `chrome-focus`): fundo de hover e contorno claro que mantêm a frente legível sobre o chrome.
- **Destaque no escuro** (`accent-dark`, `accent-foreground-dark`, `accent-soft-dark`, `selected-row-dark`, `accent-hover-dark`): papéis alternativos do fallback quando `html[data-theme="dark"]` está ativo.

### Neutral

- **Tela fria e painéis claros** (`canvas`, `surface`, `surface-elevated`): histórico, lista, ficha e faixas de controles.
- **Tinta e texto de apoio** (`text`, `text-muted`): leitura principal, horários, fila e metadados.
- **Divisória e contorno funcional** (`border`, `control-border`): separação de regiões e contorno mais forte de campos e controles.
- **Neutros do tema escuro** (`canvas-dark`, `surface-dark`, `surface-elevated-dark`, `text-dark`, `text-muted-dark`, `border-dark`, `control-border-dark`): substituem os papéis claros; não se obtêm invertendo a tela.

As rampas do sidecar são metadados de prévia. A rampa violeta clara usa oito paradas da escala real; as demais são sínteses tonais, não tokens novos da interface nem substitutos das rampas de marca em runtime.

**The Marca Soberana Rule.** O fallback violeta só se aplica quando o documento não contém `#marca-instalacao` nem `#marca-organizacao`. A busca é no `html`, cobrindo a folha de instalação emitida no `head` e a de organização emitida na árvore do `body`. Nunca copiar os valores de fallback por cima de uma marca resolvida.

**The Escopo da Jornada Rule.** Os papéis da rota são aplicados em `body:has(.inbox-workspace)` e na área de atendimento. Isso alcança os portais de menus e ficha dentro do documento enquanto o Inbox está montado, sem converter a paleta das demais jornadas.

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
- O shell reserva `100dvh`, ou `--inbox-viewport-height` atualizado pelo visual viewport quando disponível. Lista e histórico têm suas áreas de rolagem. O compositor respeita `safe-area-inset-bottom`.
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

Na toolbar da conversa abaixo de 760px úteis, hover usa `chrome-hover` e mantém `chrome-text`; foco visível usa `chrome-focus`, contorno de 2px e offset interno de -3px. Na composição intermediária, a toolbar é clara e hover usa `accent-soft` com `accent`. Essa barra fica oculta na composição de três regiões. Botões e links da ficha mantêm mínimo de 44px.

### Chips

Abas indicam o escopo e conservam a semântica Tabs. A seleção tem superfície suave, texto de destaque e contagem preenchida; as abas podem quebrar de linha. “Não lidos” continua um botão de alternância com `aria-pressed`. Filtros de canal e tags só existem quando seus dados e condições atuais os habilitam. Selos de status e responsável não viram menus por causa de setas do mockup.

### Cards / Containers

A lista tem fundo de painel; o histórico usa a tela fria; a ficha reúne identidade, tags, demandas, leads, pedidos e atividade já existentes. O container da ficha usa padding de 16px e intervalo de 20px entre grupos. Nas menores larguras, o mesmo componente ocupa o Sheet, sem uma versão funcional divergente.

### Inputs / Fields

A busca tem curva do papel `field`, contorno funcional e tamanho de texto mobile. Em uma coluna, recebe fundo escuro próprio para continuar dentro do chrome; nas composições largas, retorna ao painel claro. O compositor mantém campo de no mínimo 56px de altura, crescimento limitado e botão de envio ao lado. Hover, foco, erro e desabilitado permanecem os estados dos componentes reais.

### Navigation

O shell continua usando o registro de navegação, nomes, ícones e permissões existentes. O Inbox altera a expressão visual de cabeçalho e sidebar. O item atual recebe seleção suave com destaque; os demais usam texto claro de apoio. A sidebar existente ocupa 240px expandida ou 64px recolhida, com ícones do mapa canônico em `lib/ui/icons.ts`. A biblioteca primária da feature é Phosphor via esse mapa; componentes compartilhados legados não são permissão para novos imports diretos.

### Conversa e compositor

Mensagens recebidas têm avatar de contato ou iniciais, quando a identidade está disponível. No mobile, as enviadas usam ação de marca com frente correspondente; nas composições a partir de 760px úteis, usam superfície suave com texto de leitura. Manter nota interna, falha, mídia, citação, revogação e edição como estados existentes, sem normalizá-los em um balão genérico.

“Responder” e “Nota interna” permanecem modos distintos. A ferramenta de áudio aparece no estado sem texto; envio aparece conforme rascunho e modo. Anexos, emoji, sugestões, bloqueios e atalhos mantêm seus handlers e condições. Uma captura com rascunho do mockup não autoriza alterar essa lógica.

## Do's and Don'ts

### Do:

- **Do** respeitar a precedência da marca resolvida e a troca de tema.
- **Do** medir a largura útil do Inbox antes de escolher uma, duas ou três regiões.
- **Do** manter ações, estados e permissões existentes ao traduzir as referências aprovadas.
- **Do** usar os ícones do mapa canônico e componentes reais.
- **Do** conferir foco, contraste, quebra de texto e controles alcançáveis nos estados mobile e desktop.

### Don't:

- **Don't** espalhar o fallback violeta do Inbox para outras jornadas.
- **Don't** importar uma imagem de tela como interface ou acrescentar imagens de conteúdo ausentes do produto.
- **Don't** criar menus, funcionalidades ou regras de negócio a partir de detalhes incidentais dos mockups.
- **Don't** converter texto pequeno, colisões ou bordas decorativas apontadas pela revisão em regras para futuras telas.
- **Don't** tratar capturas sintéticas como comprovação de backend, envio, Realtime, teclado ou aparelho físico.
