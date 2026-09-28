# Assistente Deskcomm — base de suporte

Esta base orienta onboarding e dúvidas de quem usa o CRM. O runtime do plugin entrega somente artigos aprovados e válidos; o repositório é referência de manutenção, não uma ferramenta aberta ao cliente.

## Conteúdo e operação

- `articles/`: artigos em linguagem de usuário, sem código ou dados reais.
- `evidence.json`: fontes e hashes usados na revisão de cada artigo; exclusivo do fluxo de manutenção, não retornado pelas ferramentas.
- `catalog.json`: catálogo determinístico gerado pelo mantenedor e verificado no CI.
- [Política de segurança](security.md): acesso, conteúdo proibido e limites reais da proteção.
- [Manutenção e atualização](maintenance.md): atualização após mudanças na main.
- [Configuração no ChatGPT](chatgpt-setup.md): instalação local e pendências para atendimento remoto.
- [Projeto compartilhado no ChatGPT](chatgpt-project.md): atendimento da equipe com contas gratuitas e seus limites.
- [Instruções do assistente](../../plugins/assistente-deskcomm/skills/deskcomm-suporte/SKILL.md): fonte de verdade do comportamento.

## Precedência para escrever ou revisar artigos

1. `docs/support` e documentação oficial do próprio repositório.
2. Frontend e testes, para confirmar rótulos, caminhos e comportamento observado.
3. API e regras de negócio, somente para esclarecer o funcionamento.

Uma descrição antiga não vence evidência atual. Registre divergências e limite a orientação ao comportamento confirmado. Não converta planos/PRDs em promessas de funcionalidades disponíveis. A lista de fontes é rastreabilidade; não é garantia de que todos os efeitos de uma mudança foram identificados.

## Escopo desta primeira versão

Os passos e rótulos dos cinco artigos iniciais foram CONFIRMADOS por leitura das fontes e testes citados nas evidências. O CRM não foi executado nesta revisão documental; conexão funcionando, versão implantada e acesso do cliente são NÃO VERIFICADOS. Recomendações de minimização e escalonamento são política do assistente, não promessa de recurso do CRM.

Plugin local via MCP stdio, sem credenciais e sem serviço remoto. A base remota é sempre `MurilObras/crm-multiworkspace`, branch `main`. Enquanto este catálogo não estiver na main, o plugin informa indisponibilidade, sem recorrer ao código nem ao conteúdo da branch de trabalho.

O código, as instruções e a política ficam separados dos dados de suporte: novos artigos aprovados na main podem aparecer sem reinstalação; mudanças no runtime ou nas instruções exigem nova versão/reinstalação do plugin.
