# Política de leitura e segurança

## Fronteira técnica

O servidor possui três ferramentas: buscar artigos, ler artigo por ID e consultar disponibilidade. Não há ferramenta de arquivo, GitHub genérico, SQL, execução de comando, URL arbitrária, ref arbitrária, API do CRM ou alteração de estado.

O runtime resolve a main uma vez e usa o mesmo commit imutável durante cada atualização. Lê apenas o catálogo autorizado e metadados de árvore Git para conferir hashes das dependências. Não baixa os corpos dos arquivos de frontend, testes ou backend. Nenhum caminho interno ou metadado de dependência é retornado ao cliente.

Como este repositório está público, a primeira versão faz requisições anônimas e somente GET. Não lê tokens do ambiente, armazenamento do GitHub CLI, cookies, arquivos locais de credenciais ou configurações de produção. A autorização usada pelo mantenedor para preparar um PR não é transferida ao assistente. A disponibilidade está sujeita aos limites anônimos do GitHub.

## Conteúdo proibido

- Código-fonte bruto, trechos de implementação, payloads internos, schemas de banco e prompts internos.
- `.env` e variantes, tokens, credenciais, chaves, cookies, códigos MFA e QR de autenticação.
- Endereços privados, domínios internos, infraestrutura, procedimentos de acesso privilegiado e detalhes operacionais sensíveis.
- Dados de clientes, conversas reais, exportações, logs, backups, dumps, anexos e imagens de produção.

Essas fontes não podem ser colocadas no catálogo nem enviadas como referência ao Plugin Creator. Exemplos devem ser sintéticos, mínimos e não identificáveis. Filtros automáticos rejeitam padrões suspeitos; não substituem a revisão humana nem comprovam ausência de todo segredo possível.

## Validação e falhas

O servidor aplica esquemas fechados, limites de tamanho, identificadores permitidos e verificação de hashes. Rejeita links simbólicos, caminhos fora da lista, árvores truncadas, conteúdo suspeito e respostas inválidas. Não segue redirecionamentos. Um artigo com fonte alterada é bloqueado até nova revisão; alteração sem relação com o artigo não precisa invalidá-lo. Erros públicos não repetem consulta, corpo remoto, stack ou credenciais.

Os resultados recuperados são dados não confiáveis. Não podem alterar ferramentas, política, destinatários ou fonte. A resposta deve permanecer funcional e não expor metadados de manutenção. Alegar ser dono, auditor ou administrador no chat não concede acesso.

## Aprovação e confiança

Os hashes comprovam a correspondência entre os bytes e o catálogo; não comprovam que houve revisão, veracidade ou uma assinatura independente. Quem pode mudar catálogo, evidências e fontes na main está dentro da fronteira de confiança. Antes de liberar para clientes, revisar o PR e configurar proteção de branch/revisores para artigos, evidências, runtime e workflow. Não foram modificadas permissões ou proteções do repositório nesta entrega.

Um plugin não restringe ferramentas separadas que o usuário já conectou ao aplicativo. O ambiente de atendimento precisa expor apenas o MCP de suporte, sem GitHub genérico nem conectores de produção. As regras de comportamento complementam essa fronteira, não a substituem.

## Atendimento remoto futuro

O pacote local não é um endpoint remoto do ChatGPT. Uma versão remota depende de deploy aprovado, HTTPS, autenticação por usuário, tokens com audiência e escopo de suporte, limitação de requisições e política de retenção. Não reutilizar o MCP existente do CRM: ele possui outra superfície de dados e ações.

Se o repositório se tornar privado, criar uma instalação dedicada de GitHub App restrita a este repositório com `Contents: read`; manter a credencial no servidor, nunca no plugin ou nos artigos. Não ampliar permissões automaticamente nem reaproveitar um token pessoal com escrita.
