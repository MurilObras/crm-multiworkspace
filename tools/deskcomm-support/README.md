# Ferramentas locais da base de suporte

Requer Node 22 ou superior e Git. Não instala dependências, não inicia o CRM,
não lê arquivos de ambiente e não faz deploy. Execute a partir da raiz do clone:

```sh
node --test tools/deskcomm-support/*.check.mjs
node tools/deskcomm-support/catalog.mjs build
node tools/deskcomm-support/catalog.mjs check
```

`build` gera `docs/support/catalog.json` a partir dos artigos e das evidências
revisadas. Recusa fonte alterada, arquivo não rastreado, link simbólico, campos
extras, caminhos sensíveis e texto suspeito. `check` também exige que o catálogo
salvo seja exatamente o resultado esperado. Ambos calculam hashes das fontes
locais com Git; não imprimem seu conteúdo e não renovam a revisão silenciosamente.

Quando uma fonte mudar, o mantenedor precisa conferir a implementação, os testes
e o artigo, corrigir a orientação se necessário e só então registrar a revisão:

```sh
node tools/deskcomm-support/catalog.mjs review primeiros-passos --reviewed
node tools/deskcomm-support/catalog.mjs build
node tools/deskcomm-support/catalog.mjs check
```

O comando `review` atualiza apenas os hashes das fontes do artigo escolhido.
A flag é uma declaração do mantenedor, não uma aprovação de merge, deploy nem
uma análise automática de segurança. Nunca executar esse comando no CI para
fazer um check passar. Mudanças em artigos, evidências e catálogo seguem juntas
no PR para revisão humana. Segredos e dados de clientes não pertencem a nenhum
desses arquivos. Filtros de texto são uma defesa adicional, não prova de sigilo.

## Servidor local de consulta

```sh
node plugins/assistente-deskcomm/runtime/server.mjs
```

O processo fala MCP por entrada/saída padrão. Não é um serviço HTTP e não expõe
porta. Clientes MCP o iniciam e usam apenas `search_support`,
`read_support_article` e `support_status`. O processo não aceita parâmetros de
origem, credenciais, branch, caminho ou URL, nem lê variáveis de ambiente.

O runtime consulta somente o repositório fixo MurilObras/crm-multiworkspace:

1. Resolve `main` e fixa seu commit por no máximo 60 segundos.
2. Lê metadados da árvore Git, sem baixar corpos de código-fonte.
3. Baixa somente o catálogo fixo naquele commit e verifica seu hash Git.
4. Confere o hash do corpo de cada artigo contra o arquivo correspondente na
   árvore e os hashes de todas as suas dependências. Dependência alterada ou
   ausente bloqueia o artigo; artigos independentes continuam disponíveis.
5. Entrega somente ID, título, texto revisado e proveniência pública. Caminhos
   internos e hashes de dependências não entram nos resultados.

`main` pode estar à frente da versão instalada pelo cliente. O assistente deve
confirmar rótulos visíveis e reconhecer diferenças de versão. Se o catálogo
ainda não estiver na `main`, a resposta correta do servidor é indisponível.
Não há fallback para uma cópia embutida de artigos.

Conexões usam HTTPS para os dois hosts fixos do GitHub, sem autenticação e sem
seguir redirecionamentos. O protótipo depende de leitura pública; repositório
privado fica indisponível e nunca solicita token do usuário. Há limites de
tamanho, 7 segundos por requisição, 25 segundos por atualização, rejeição de
árvore truncada e pausa após falhas/rate limit. Falha ao renovar invalida o
cache. Uma consulta muito frequente pode atingir o limite anônimo do GitHub:
aumentar capacidade exige uma implantação futura deliberada, não colocar
credenciais no plugin de clientes. Aprovação de deploy segue separada.

## Verificação e limites

Testes usam fixtures sintéticas, respostas de rede simuladas e um processo MCP
real por stdio. Cobrem hash/adulteração, fontes desatualizadas, symlinks,
travessia de diretórios, campos inesperados, redirecionamentos, limites,
timeouts, cache inválido, rate limit, erros sem dados internos e o protocolo.
O teste de link simbólico local informa quando o Windows não permite criar
esse tipo de fixture; o caso de árvore Git com symlink é sempre exercitado.
Não são testes da interface hospedada do ChatGPT nem prova de isolamento
entre ferramentas diferentes habilitadas no mesmo chat.

O runtime implementa o subconjunto `tools` do MCP, com inicialização, ping,
listagem, chamadas e notificações, versões 2025-11-25 e 2025-06-18. Recursos,
prompts, arquivos arbitrários, sampling, logs e comandos de escrita não são
expostos. Os arquivos `.check.mjs` usam `node:test` e ficam fora do padrão
`*.test.*` do Vitest do CRM.

Referências oficiais: [transporte stdio](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
[ciclo de vida](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
[ferramentas](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) e
[limites da API GitHub](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
