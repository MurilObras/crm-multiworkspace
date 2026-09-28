# Configurar o Assistente Deskcomm

## Pacote local

O plugin em `plugins/assistente-deskcomm` contém instruções e um servidor MCP local somente leitura. Requer Node.js 22 ou superior. Inclui manifesto portátil e manifesto de compatibilidade do Codex. Não inclui credenciais nem artigos offline que possam ficar desatualizados.

O catálogo pessoal da máquina do mantenedor permite instalar e testar o plugin local. Instalação local não significa publicação no diretório nem disponibilidade para clientes no navegador. Inicie uma nova conversa após instalar para carregar ferramentas e instruções.

Para uma equipe com contas gratuitas que não pode instalar o plugin privado pessoal, há um [projeto compartilhado](chatgpt-project.md). Ele usa instruções de suporte e pode consultar a documentação pública, mas não possui a fronteira técnica nem a atualização automática do MCP.

Antes do merge, um teste na fonte main deve resultar em indisponibilidade. Isso é intencional: a branch de preparação não pode se apresentar como documentação já aprovada. Os testes com corpus sintético e o check local comprovam o caminho completo sem publicar esse conteúdo.

## ChatGPT / Plugin Creator

A sessão do navegador precisa estar autenticada e o workspace precisa permitir Plugin Creator. Não foi criado servidor remoto nem registrada uma conexão HTTP. Para a versão compartilhável pela web, primeiro revisar e aprovar o projeto de serviço remoto descrito na política de segurança; só então fazer deploy e registrar a conexão.

Após o endpoint aprovado existir, no ChatGPT:

1. Registrar somente o MCP de suporte com a autenticação aprovada. Não conectar o GitHub inteiro nem o MCP operacional do CRM.
2. No Plugin Creator, criar **Assistente Deskcomm**, com descrição “Ajuda segura para usar o seu CRM”.
3. Adicionar as instruções de `plugins/assistente-deskcomm/skills/deskcomm-suporte/SKILL.md`. Omitir o front matter quando o campo esperar apenas instruções.
4. Incluir somente as ferramentas `search_support`, `read_support_article` e `support_status`.
5. Testar privadamente onboarding, falha de conexão, ausência de base, artigo desatualizado e tentativas de obter código/segredos. Conferir que nenhum conector amplo foi incluído.
6. Compartilhar apenas após aprovação explícita do proprietário e validação na conta de destino.

Brief para colar no Plugin Creator:

> Crie um plugin privado chamado Assistente Deskcomm para onboarding e dúvidas de uso do CRM. Use as instruções anexas e apenas o MCP de suporte aprovado, com ferramentas search_support, read_support_article e support_status. Responda em português com passos curtos baseados em artigos válidos. Se faltar informação, diga isso e encaminhe ao responsável. Não inclua GitHub genérico, API operacional do CRM, navegador ou acesso a arquivos/dados de clientes. Não publique ou compartilhe sem minha aprovação. Se o MCP ainda não estiver registrado, deixe essa dependência pendente, sem inventar URL ou conexão.

## Referências oficiais verificadas

- [Criar plugins no ChatGPT](https://learn.chatgpt.com/docs/build-plugins).
- [Empacotar plugins](https://developers.openai.com/plugins/build/plugins).
- [Conectar e testar um MCP](https://developers.openai.com/plugins/quickstart).

Essas páginas descrevem o fluxo; não comprovam que a conta do usuário tem cada opção. Disponibilidade e autorização precisam ser verificadas na interface autenticada.
