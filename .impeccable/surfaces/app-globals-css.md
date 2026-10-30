---
version: 1
slug: "app-globals-css"
primary_target: "app/globals.css"
related_targets: ["components/inbox/inbox-workspace.css", "components/ui/button.tsx", "app/design/lib/tokens.ts", "app/global-error.tsx"]
---

# Colorimetria Taskly — contrato da superfície

Pedido confirmado em 29/10/2026: trocar somente as cores de todas as telas, preservando funcionalidades e responsividade mobile. A referência atual substitui a direção violeta anterior somente no aspecto cromático.

## Direction contract

**THESIS:** atendimento e gestão legíveis no celular e desktop, com identidade azul luminosa e estados reconhecíveis.

**OWN-WORLD:** azul cobalto, gradientes estáticos de marca, superfícies claras frias e acentos lima contidos; tema escuro com neutros azulados. Marca personalizada e semânticas de status continuam soberanas.

**STORY:** navegar, localizar informação e executar as ações existentes com a mesma hierarquia e comportamento.

**FIRST VIEWPORT:** composição atual de cada página preservada; navegação recebe gradiente, seleção recebe destaque e conteúdo permanece sobre superfícies de leitura estáveis. Campos, fontes, espaçamentos, breakpoints e alvos de toque mantidos.

**FORM:** adaptação cromática do projeto Taskly, Behance 257138265, com 34 imagens locais em Downloads/Taskly-Referencias-CRM. Direção aprovada antes da execução; não houve concept-seed ou nova composição nesta etapa.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Critérios e limites

Base: v3.9.3, commit 710b02e03e5f280eeddf4fa3ac5f45e31c2e24a0; branch `feat/taskly-colorimetria`. Plano anterior: Plandex com contexto upstream Impeccable, revisado pelo Codex. A implementação desta etapa foi editada pelo Codex, sem chamada nova a provedores de IA. Caveman descreve a voz concisa, não um executor. Inventário: 112 entradas, sendo 103 com UI e nove aliases sem UI própria; alcance de tokens não significa captura individual de todas as páginas.

Preservar layout, hooks de viewport, regras de negócio, marca, autenticação, dados, APIs, envio e automações. Gradientes apenas em background-image; tokens de cor permanecem sólidos. Sem GIFs, vídeos, fontes, bibliotecas ou JavaScript decorativo novos.

Dois ciclos de revisão/correção: branch e depois PR; checks obrigatórios no head final antes de integrar. Publicação por imagem oficial versionada, backup e rollback conferidos. Capturas sintéticas apoiam revisão visual e não comprovam integração ou aparelho físico. Resultados e limitações serão registrados com as evidências de cada ciclo.

## Registro da implementação local

Os papéis globais em `app/globals.css` e os aliases do Inbox usam a direção Taskly documentada em [DESIGN.md](../../DESIGN.md). Esse registro substitui o fallback violeta/lavanda do contrato anterior somente em cor. Gradientes de chrome, ação e ambiente são imagens estáticas; sólidos continuam válidos em aliases, texto, borda, foco e régua. Folhas de marca no head/body prevalecem e retiram gradientes de ação e ambiente. Semânticas mantêm suas cores; a frente destrutiva escura é própria, legível sobre o vermelho preservado.

O ID `sage` da seleção padrão é legado de compatibilidade; a paleta visível é Taskly. A régua gerada acompanha os sólidos atuais. O algoritmo histórico de derivação das marcas e sua fixture Sage original permanecem, evitando recalibrar marcas cadastradas pela nova paleta.

Fotografia desta etapa: o [primeiro ciclo completo](../../evidence/taskly/revisoes/revisao-local-completa.txt) abriu somente F1, gradiente cobrindo ação destrutiva; o [veredito](../../evidence/taskly/revisoes/veredito-local-f1.txt) resolveu F1 com ship restrito à correção. Os 31 PNGs principais foram refeitos no build final; oito confirmações habilitadas cobrem repouso/hover, claro/escuro, 390 e 1440px, sem executar exclusão. As 13 capturas suplementares antecedem F1, e settings/templates mostra um estado 403. O [índice](../../evidence/taskly/README.md) conserva esses limites, a sequência dos testes e os gates separados de revisão no PR, CI final e publicação. Nenhum raster foi incorporado à UI; capturas são evidência de desenvolvimento.
