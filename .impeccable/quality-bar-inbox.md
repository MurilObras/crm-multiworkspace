# QUALITY BAR — Inbox

Card de desenvolvimento registrado com a documentação do redesign em 29/10/2026. A autoridade são as três referências aprovadas identificadas no [contrato da superfície](surfaces/components-inbox-inboxlayout-tsx.md), junto às regras existentes do produto.

## Barra visual aprovada

- **Estrutura:** navegação/cabeçalho profundos, painéis claros, seleção suave. Marca personalizada e tema escuro mantêm precedência.
- **Lista:** título, busca, filtros disponíveis, abas e primeiras conversas legíveis; nome, prévia, hora, não lidos e posição na fila preservam significado e condições.
- **Conversa mobile:** identidade e estado reconhecíveis, ações reais alcançáveis, avatar recebido, modos e campo de escrita operáveis.
- **Desktop:** lista, conversa e ficha seguem a largura útil; mensagens enviadas suaves e ficha com identidade e hierarquia de seções.
- **Acabamento:** texto de leitura mobile de 16px nos campos, metadados de atendimento com mínimo aprovado de 12px, contraste verificável, foco visível e nenhuma colisão interna ou conteúdo funcional cortado.
- **Toque:** meta de 44px para alvos e 8px entre ações principais, preservando todas as condições do produto. Medir também controles herdados, não presumir cobertura pelo CSS do grupo.

## Matriz de verificação necessária

| Eixo | O que a evidência deve demonstrar |
| --- | --- |
| Largura útil | Uma região abaixo de 760px, duas de 760px até menos de 1100px, três a partir de 1100px. Confirmar a largura medida do container, não inferir só pela janela. |
| Tamanhos de tela | 320, 360, 390 e 430px; limiares globais 767/768/769, 1023/1024/1025 e 1279/1280/1281; desktop 1440px. A lista de referência é alvo de cobertura, não lista de capturas já realizadas. |
| Layout real | Sidebar expandida/recolhida, busca no shell sem invasão dos controles e estado lista/conversa em cada composição. |
| Marca e tema | Padrão sem folha de marca; instalação personalizada com folha no head; organização personalizada; tema claro/escuro e portais. |
| Navegação | Lista → conversa → ficha → fechar ficha → Conversas; foco, seleção, carregamento, vazio e contato indisponível. |
| Atendimento | Ações condicionais preservadas; responder/nota, anexos, citação, cancelamento, áudio, bloqueios, falha, texto longo e estados de mídia. Não gerar envio real durante uma inspeção visual sintética. |
| Acessibilidade | Teclado/foco, nome acessível, texto ampliado, contraste dos pares efetivamente pintados e ausência de corte dentro das caixas. |
| Hardware | Teclado virtual, safe area, rolagem e campo visível em aparelho móvel real; permanece pendente quando só houver emulação. |

## Evidência e decisão

A [revisão local inicial](../evidence/inbox-regulatis/revisoes/revisao-local-inicial.txt) retornou **fix**; o [veredito local](../evidence/inbox-regulatis/revisoes/revisao-local-veredicto.txt) resolveu os sete itens pontuados, com ship limitado a esse lote. O [índice de evidências](../evidence/inbox-regulatis/README.md) entrega as referências, cada PNG, medições e pareceres históricos fora dos diretórios locais ignorados.

Os selos e metadados da lista, excedente de tags, remetente IA e horários de mensagem usam `text-xs`; OwnerBadge é consumido sem compacto. A ficha aplica mínimo de 44px a botões e links. A toolbar mobile preserva frente clara no hover profundo e contorno claro de foco; no intermediário, hover usa superfície suave e destaque. A segunda rodada documenta esses estados e a resolução local correspondente.

No segundo ciclo, a [revisão integral do PR](../evidence/inbox-regulatis/revisoes/revisao-pr61-inicial.txt) abriu F1/F2/F3. A [reavaliação intermediária](../evidence/inbox-regulatis/revisoes/revisao-pr61-intermediaria.txt) resolveu teclado das preferências e contraste da nota, mas recusou body-only como prova suficiente de reserva de altura. A fonte final observa caixas anteriores/ancestrais e childList dos ancestrais. O [veredito final](../evidence/inbox-regulatis/revisoes/revisao-pr61-veredicto-final.txt) resolveu os três itens após conferir menus, nota clara/escura e aviso válido com body mínimo real e área visível emulada de 480px. O ship é restrito às correções pontuadas.

O harness local usa componentes reais com dados sintéticos e backend substituído. Sua aprovação visual, se vier a ocorrer, terá esse alcance. Integração, envio, Realtime real, hardware e desempenho exigem evidência própria.

## Gates antes de integrar/publicar

- Tipo, lint e testes relevantes, incluindo a validação de UI exigida pelo repositório.
- CI obrigatório do repositório aprovado.
- Primeiro ciclo: revisão local independente, correção e novo veredito.
- Segundo ciclo: revisão do PR, correção e nova validação antes da integração.
- Integração e publicação seguem a autorização e a rotina do projeto depois desses gates.

## Estado deste card

Os dois ciclos encerraram as correções pontuadas; design-qa registra passed apenas nesse escopo visual. O [addendum dos testes](../evidence/inbox-regulatis/revisoes/revisao-pr61-testes-integrados.txt) não encontrou achado material nos dois diffs finais de navegação. Sua execução, CI do novo head, integração geral e hardware têm gates próprios. Este card não registra aprovação global da superfície, não cria métricas retrospectivas de reprodução e não autoriza publicação.
