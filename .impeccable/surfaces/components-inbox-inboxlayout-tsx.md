---
version: 1
slug: "components-inbox-inboxlayout-tsx"
primary_target: "components/inbox/InboxLayout.tsx"
related_targets: ["components/inbox/inbox-workspace.css","app/app/_components/AppShell.tsx","components/inbox/ConversationHeader.tsx","components/inbox/Composer.tsx","components/inbox/CRMSidePanel.tsx"]
---

# Inbox — contrato da superfície

Registro de desenvolvimento da direção aprovada, persistido durante a documentação do redesign existente em 29/10/2026. Não foi o insumo de um scaffold anterior e não registra aprovação retrospectiva de implementação.

## Escopo e modo

- **Modo:** Operate / Read.
- **Alvo primário:** `components/inbox/InboxLayout.tsx`, rotas `/app/inbox` e `/app/inbox/[id]`.
- **Alvos relacionados:** componentes em `components/inbox/`, `components/inbox/inbox-workspace.css`, `app/app/_components/AppShell.tsx`, shell compartilhado e `hooks/inbox/useInboxViewport.ts`.
- **Público e tarefa:** atendentes e gestores que localizam conversas, entendem comando e contexto e atendem, com uso frequente no celular confirmado pelo dono.
- **Limite:** somente expressão visual e composição autorizadas do atendimento e seu shell. APIs, banco, permissões, estados, automações, envio, notas, anexos, citações, paginação e Realtime são preservados.

## Direction contract

**THESIS:** atendimento legível e operável com mobile frequente. A lista e a conversa não devem exigir que a pessoa role uma região inteira antes de alcançar a próxima tarefa.

**OWN-WORLD:** navegação profunda, painéis de leitura claros e seleção suave. O padrão violeta/lavanda cede aos tokens da marca e ao tema; componentes reais e contornos funcionais sustentam o desenho.

**STORY:** localizar na lista → abrir conversa → responder ou registrar nota interna → consultar ficha → voltar ao atendimento. Estado e permissões determinam as ações disponíveis.

**FIRST VIEWPORT:** busca, filtros, abas e primeiras conversas acessíveis na lista; identidade, ações e campo alcançáveis na conversa. O espaço útil decide uma, duas ou três regiões sem colisões.

**FORM:** adaptação de referências previamente aprovadas aos componentes existentes, com ícones do mapa canônico e nenhuma feature nova. Não houve roll nem seed comprovado; não há posição ordenada ou referência de seed a registrar. Não se atribui `seed: none (unavailable)` a uma ferramenta que não foi executada.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Autoridade visual e memorable moment

A aprovação prévia informada pelo responsável escolhe a combinação de controles explícitos e estrutura clara da proposta 04, com conversa mobile 05 e atendimento desktop 06. O momento reconhecível é a passagem da lista clara para a conversa sob a mesma navegação profunda, preservando o contexto da pessoa e o caminho de volta.

Referências externas ao repositório:

- `C:/Users/muril/Downloads/Regulatis-Referencias-CRM/propostas-inbox/04-combinacao-fila-controles.png`
- `C:/Users/muril/Downloads/Regulatis-Referencias-CRM/propostas-inbox/05-conversa-mobile.png`
- `C:/Users/muril/Downloads/Regulatis-Referencias-CRM/propostas-inbox/06-atendimento-desktop.png`
- `C:/Users/muril/Downloads/Regulatis-Referencias-CRM/propostas-inbox/especificacao-interface.json`

A especificação contém propostas de tokens e pares estáticos de contraste. O código é a fonte dos tokens implementados em [DESIGN.md](../../DESIGN.md); o contraste proposto não certifica todos os estados renderizados. Poppins ficou condicionada a avaliação no arquivo de referência; o código preserva Atkinson.

Nenhum raster dessas telas foi incorporado à UI. Não há novas imagens de conteúdo a produzir ou publicar neste escopo; avatares e logos continuam vindo dos mecanismos existentes.

## Tradução para o produto

| Referência | Tradução nos componentes reais | Limite |
| --- | --- | --- |
| 04 — fila e controles | InboxFilters, ConversationList, ConversationListItem e shell | Abas por papel, filtros por disponibilidade e toggle “Não lidos” continuam regidos pelo produto. |
| 05 — conversa mobile | ConversationHeader, ChatThread, MessageBubble, Composer e Sheet de ficha | Ações mudam com estado/role; áudio e enviar mudam com o rascunho; “Você” no mockup não obriga atribuição. |
| 06 — atendimento desktop | Container útil com lista, conversa e CRMSidePanel | Três regiões só a partir de 1100px úteis; dados e seções já existentes são preservados. |

A seleção local tem caminho explícito de voltar. O código mantém a limitação preexistente de seleção fora da URL; a mudança não promete que o botão voltar do navegador reproduza o gesto “Conversas”.

## Adaptação honesta do processo

Foi aplicado o trabalho ao CRM existente. Não foi feito scaffold, concept-seed ou a maquinaria comp-led de `state/spec/hero/final`. Não existe evidência de um seed, medição de reprodução ou score desses gates; nada disso será fabricado. Este contrato e o card [QUALITY BAR](../quality-bar-inbox.md) organizam a evidência disponível daqui em diante, sem fingir que existiam antes do código.

A revisão independente inicial está em [revisao-local-inicial.md](../../.superpowers/evidence/inbox-regulatis/revisao-local-inicial.md), com disposição **fix**. A reconciliação de fonte confirmou metadados de atendimento com `text-xs` explícito, remoção dos seletores de slot inexistentes, mínimo de 44px também nos links da ficha e hover/foco da toolbar adaptados ao chrome mobile e ao painel intermediário. Essas correções de código ainda exigem capturas renovadas e novo veredito visual. Capturas afetadas por erro de montagem/formatação do shell foram rejeitadas pelo responsável, não aceitas como prova.

As capturas locais usam componentes reais com backend substituído por dados sintéticos. Podem apoiar avaliação visual e de interação no harness, com seus limites; não demonstram integração, envio de mensagens, Realtime de produção, teclado móvel real ou uso em hardware físico.

## Pendências de aceitação

Conferir o [QUALITY BAR](../quality-bar-inbox.md) nas referências e na nova evidência, finalizar o novo veredito local e cumprir os gates do repositório. Tipo, lint, testes relevantes, CI e os dois ciclos de revisão — local e depois no PR — devem passar antes de integrar/publicar. A presença deste documento, de DESIGN.md ou do sidecar não significa QA passed nem publicação autorizada.
