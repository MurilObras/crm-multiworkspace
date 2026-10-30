# Régua de qualidade — colorimetria Taskly

Fotografia da etapa local em 29/10/2026: primeiro ciclo completo e F1 resolvido. O ship do veredito cobre somente F1; este arquivo não declara aprovação geral, CI final ou publicação.

Modo Operate. A direção aprovada troca somente as cores da interface existente por azul cobalto, gradientes luminosos e acentos lima contidos. Referência: projeto Taskly no Behance, 257138265. Estrutura, funcionalidades, fontes, medidas e responsividade existentes são preservadas.

O [contrato da superfície](surfaces/app-globals-css.md) prevalece sobre a direção violeta anterior somente em cor. As marcas personalizadas continuam prevalecendo sobre o padrão. Semânticas de erro, sucesso, agenda e categorias são preservadas.

Critérios: texto com contraste de pelo menos 4,5:1; controles e foco com pelo menos 3:1; gradientes medidos com a frente real; nenhum gradiente usado como token de cor sólida. Manter o campo de mensagem dentro da área útil, alvos do Inbox de 44px e ausência de overflow horizontal. Verificar temas, hover, foco, menus, Sheet e marca própria.

O [pacote de evidências](../evidence/taskly/README.md) vem do build local de produção e do Supabase pg15 fresco, com dados sintéticos. O [manifesto principal](../evidence/taskly/manifesto.json) indexa 31 PNGs refeitos após F1. Os testes de UI cobrem larguras de 320 a 1440px, ambos os temas, menus, ficha e marca da organização. A comparação com a base registra 188 declarações de geometria idênticas (27 globais e 161 do Inbox). A cobertura estrutural é de 103 páginas com UI entre 112 entradas, com nove aliases; não é uma captura individual de cada página.

O [veredito local F1](../evidence/taskly/revisoes/veredito-local-f1.txt) pontuou como resolvida a única correção aberta pela revisão completa: gradiente primário sobre a ação destrutiva. Oito confirmações habilitadas mostram vermelho sem gradiente, repouso e hover, temas claro/escuro e larguras 390/1440px; o teste abre e cancela, sem excluir. A frente destrutiva escura atual tem mínimo medido de 4,67267:1; hover claro tem 4,692:1. O ship permanece restrito a F1. As 13 capturas de aplicações suplementares antecedem essa correção, e settings/templates é estado 403, sem certificar formulário.

O detector único apontou adições cromáticas deliberadas, agora registradas em DESIGN.md e sidecar a partir do CSS. Seus avisos de tipografia, raio e bounce referem-se a código preservado. A borda lateral de 3px no exemplo de citação do laboratório de design também é anterior; não foi criada nem alterada pela troca de cores. Essas exceções não são canonizadas como novas regras. O detector não foi repetido e não constitui aprovação visual.

Na fotografia desta etapa, a suíte completa de 786 arquivos/8724 aprovados e uma falha esperada antecede F1. Depois de F1 passaram build de produção, cinco E2E focais (quatro Inbox e uma confirmação), 55 verificações dirigidas e lint/typecheck, com avisos herdados no lint. O índice distingue esses resultados informados pelo executor das verificações documentais. Aparelho físico e transporte WhatsApp não foram testados. O segundo ciclo independente no PR e o CI do head final eram gates pendentes separados neste instante; publicação requer imagem oficial versionada, backup e rollback. Resultados externos posteriores não são implicados por este registro.
