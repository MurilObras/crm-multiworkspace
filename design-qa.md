# QA visual do atendimento — 29/10/2026

final result: passed

Este resultado é restrito à comparação visual e às sete correções pontuadas no primeiro ciclo. Não aprova integração, entrega de mensagens, aparelhos físicos, CI ou publicação. O segundo ciclo de revisão do PR continua obrigatório.

## Fontes e normalização

Referências: `04-combinacao-fila-controles.png`, `05-conversa-mobile.png` e `06-atendimento-desktop.png` do conjunto aprovado em Downloads/Regulatis-Referencias-CRM/propostas-inbox. O contrato está em `.impeccable/surfaces/components-inbox-inboxlayout-tsx.md`.

Comparações pareadas em `.superpowers/evidence/inbox-regulatis/round-2/comparacao-lista.png`, `comparacao-conversa.png` e `comparacao-desktop.png`. Imagens de referência normalizadas para 390×844 e 1440×1024; capturas em CSS pixels, devicePixelRatio 1. Foram conferidas as dimensões dos PNGs. Também foram abertas lista e conversa em 320×844 e 768×1024. O primeiro lote usou 320×740.

Os componentes de produção foram renderizados num harness Vite local com dados sintéticos no lugar dos hooks de backend. A conversa está aberta e sem dono, diferentemente do mock atribuído ao usuário: os botões seguem as condições reais, não o estado fictício do desenho. Campo vazio mostra microfone; campo preenchido mostra envio. Não foi inicializado um novo produto ou template.

## Superfícies de fidelidade

- Tipografia: mantida Atkinson existente, conforme especificação; campos mobile 16px, metadados explícitos 12px. Poppins do mock não foi adicionada.
- Espaçamento: composição pela largura útil do atendimento, abaixo de 760px, intermediária até 1099px e três painéis desde 1100px. Alvos frequentes de 44px; abas quebram linha para preservar contagens e rótulos.
- Cores: navegação profunda, leitura clara e seleção lavanda. Tema escuro preservado. Marca sintética azul no head permaneceu azul em ambos os temas; o fallback é habilitado apenas sem folha de marca de instalação/organização.
- Imagens: avatares reais usam o endpoint existente; dados sem foto usam as iniciais do componente existente. Ícones vêm do mapa canônico. Nenhuma tela rasterizada ou ilustração foi incorporada ao produto.
- Conteúdo: rótulos, filtros, condições das ações, notas internas, citações, estados de domínio e mecanismos de envio foram preservados. Diferenças de dados e quantidade de ações são adaptações esperadas.

As comparações pareadas incluem cabeçalho, mensagens, composer e ficha, suficientemente legíveis nos arquivos de resolução integral. Estados adicionais: tema escuro, menu, ficha aberta, foco/hover da toolbar e nota interna.

## Histórico da revisão

O detector real do Impeccable foi executado uma vez e apontou duas bordas laterais de 2px em citações (`detector.json`). O primeiro parecer independente pediu sete correções: precedência da marca; avatares e balão desktop; ficha/metadados/alvos; colisão da busca no tablet; bordas das citações; foco/portais; persistência da direção.

Todas foram corrigidas e recapturadas. Uma captura do menu foi rejeitada por enquadramento inválido, substituída no mesmo caminho e novamente inspecionada. O veredicto posterior pontuou os sete itens como resolvidos, com `disposition: ship` apenas nesse escopo. Relatórios em `.superpowers/evidence/inbox-regulatis/revisao-local-inicial.md` e `revisao-local-veredicto.md`.

Durante a formatação, a concatenação de classes do shell perdeu espaços; foi corrigida com `cn()` e as capturas renovadas. O contrato documenta que a maquinaria formal comp-led de state/spec/diffs não foi executada; não há seed, score ou aprovação retrospectiva inventados.

## Verificações e limites

Medições em 23 larguras entre 320 e 1440px não encontraram colisão dos controles do cabeçalho nem overflow horizontal (`round-2/medidas-limites.json`). Na prévia, abrir/fechar ficha manteve a seleção; Responder/Nota manteve o rascunho; o campo mediu 16px. Após abrir e fechar a ficha, o hover/foco da toolbar foi medido com fundo rgb(52,38,76), texto rgb(250,247,255) e contorno rgb(226,206,255). Nenhum novo erro de aplicação apareceu no carregamento final; o histórico do console conserva erros antigos de preparação do harness.

Os testes E2E integrados usam fixture própria e banco local, em `tests/e2e/inbox-responder-citando.spec.ts`, incluindo a matriz de layouts. A prova real e a suíte completa de Linux serão registradas no PR; os resultados do harness não as substituem. O hook de visual viewport tem testes de redução, restauração, zoom e limpeza; teclado/hardware físico continua sem ensaio.
