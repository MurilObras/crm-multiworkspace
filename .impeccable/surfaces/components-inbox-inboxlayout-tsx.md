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

Referências aprovadas com cópia durável no repositório:

- `evidence/inbox-regulatis/referencias/04-combinacao-fila-controles.png`
- `evidence/inbox-regulatis/referencias/05-conversa-mobile.png`
- `evidence/inbox-regulatis/referencias/06-atendimento-desktop.png`

As cópias vêm do conjunto local aprovado em Downloads/Regulatis-Referencias-CRM/propostas-inbox. A especificação de origem permanece em `C:/Users/muril/Downloads/Regulatis-Referencias-CRM/propostas-inbox/especificacao-interface.json`. O [índice de evidências](../../evidence/inbox-regulatis/README.md) identifica cada captura, medição e parecer entregue.

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

A [revisão local inicial](../../evidence/inbox-regulatis/revisoes/revisao-local-inicial.txt) pediu sete correções; o [veredito local](../../evidence/inbox-regulatis/revisoes/revisao-local-veredicto.txt) as pontuou como resolvidas no harness, com ship restrito a esse lote. Metadados explícitos, mínimo de 44px nos links da ficha, hover/foco, marca e composição estão registrados na segunda rodada. Capturas afetadas por montagem/formatação inválida foram rejeitadas e substituídas, não aceitas como prova.

A [revisão integral do PR 61](../../evidence/inbox-regulatis/revisoes/revisao-pr61-inicial.txt) abriu F1 teclado das preferências, F2 contraste da nota e F3 altura ao mudar aviso. A [reavaliação intermediária](../../evidence/inbox-regulatis/revisoes/revisao-pr61-intermediaria.txt) resolveu F1/F2 e manteve F3 parcial. Idiomas/tema usam itens Radix navegáveis; nota selecionada tem superfície opaca e tinta/contorno warning-fg. F3 observa caixas anteriores/ancestrais e alterações childList dos ancestrais, fora da subárvore de mensagens. O [veredito final](../../evidence/inbox-regulatis/revisoes/revisao-pr61-veredicto-final.txt) reabriu as capturas válidas com body mínimo real/área reduzida e resolveu F1/F2/F3, com remaining clear e ship restrito ao lote.

As capturas locais usam componentes reais com backend substituído por dados sintéticos. Podem apoiar avaliação visual e de interação no harness, com seus limites; não demonstram integração, envio de mensagens, Realtime de produção, teclado móvel real ou uso em hardware físico.

## Pendências de aceitação

O [QUALITY BAR](../quality-bar-inbox.md) e o QA visual registram o aceite restrito dos dois ciclos. O [addendum dos testes](../../evidence/inbox-regulatis/revisoes/revisao-pr61-testes-integrados.txt) não encontrou achado material nos dois diffs de navegação. Permanecem build, testes relevantes, CI obrigatório do novo head e os gates reais de integração antes de integrar/publicar. Os resultados Linux do head anterior e o ship visual limitado não certificam automaticamente este worktree. A presença deste documento, de DESIGN.md ou do sidecar não autoriza publicação.
