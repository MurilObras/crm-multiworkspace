# Atualização da base

## Fluxo automático após merge autorizado

1. O PR que muda uma funcionalidade revisa os artigos afetados e suas evidências.
2. O mantenedor confirma a redação e os hashes; gera o catálogo e executa as verificações.
3. O CI em PR valida catálogo e dependências, além dos testes de segurança. O workflow possui somente `contents: read`, sem deploy, publicação ou gravação na branch.
4. Depois de merge autorizado na main, o mesmo check roda novamente. O runtime consulta a main sob demanda com cache curto e troca o conjunto validado.
5. Se uma fonte mudar sem o artigo ser revisado, o artigo fica indisponível. A orientação deve reconhecer a falta de base atualizada e escalar. Nunca mostrar o artigo antigo como atual.

Não há geração e aprovação autônoma de texto de suporte. Atualizar automaticamente a leitura é diferente de aprovar automaticamente conteúdo. Uma revisão pode concluir que o artigo continua correto; nesse caso, atualiza-se a evidência com justificativa no PR, sem reescrever por obrigação.

## Manutenção

As instruções e comandos executáveis estão no [guia das ferramentas](../../tools/deskcomm-support/README.md). O builder não deve abençoar hashes novos silenciosamente: a revisão é uma decisão explícita do mantenedor. Acrescentar/remover artigos exige atualizar as evidências e regenerar o catálogo.

Use fontes precisas para não bloquear tudo em mudanças sem relação. Inclua os componentes, traduções, testes e regras dos quais a orientação depende. Hash de dependência só detecta arquivos declarados; novos comportamentos ou dependências omitidas continuam exigindo revisão de impacto. Compare com a versão instalada antes de orientar alguém cujo CRM difere da main.

## Limites de operação

- Catálogo novo na main: incorporado pela próxima atualização bem-sucedida do runtime.
- Mudança no código/instruções do plugin: requer revisão e reinstalação; não baixa nem executa código novo da main.
- GitHub inacessível, limite atingido ou catálogo inválido: falha segura e mensagem de indisponibilidade. Não usar cache vencido.
- Não existe monitoramento permanente criado no aplicativo. A atualização é feita por consulta; o check de CI é acionado pelos eventos do repositório.
- Este PR não altera branch protection, visibilidade, ambientes ou produção. O novo check só será obrigatório para merge se o proprietário configurar essa exigência.

## Laço de correção

O [mapa de arquitetura](../architecture/assistente-deskcomm.architecture.json) registra as conexões do plugin externo ao CRM. A porta de entrada é a seleção do plugin; a saída são artigos ou indisponibilidade. O status do MCP e o check support-knowledge tornam falhas visíveis sem registrar consultas ou dados de clientes.

Entrada: dúvida sem cobertura ou artigo bloqueado. Saída: relato sanitizado ao responsável. Correção: PR atualiza artigo e evidência, CI confirma consistência, merge aprovado torna a orientação disponível. Nenhuma conversa de cliente é armazenada automaticamente nem usada para reescrever a base.
