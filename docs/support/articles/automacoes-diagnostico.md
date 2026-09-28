# Criar e diagnosticar uma automação

Com papel de gerente ou administrador, abra **Canais → Webhooks → Automações**. Uma automação reúne **QUANDO** algo acontece, **SE** determinadas condições são atendidas e **ENTÃO** quais ações executar.

## Preparar uma automação

1. Clique em **Nova automação** e dê um nome que descreva seu objetivo.
2. Em **QUANDO**, escolha o gatilho. As opções incluem contato novo por webhook, mudança de etapa, mensagem recebida no WhatsApp e adição de tag a lead ou contato.
3. Em **SE (opcional)**, escolha os filtros necessários. Quando há várias condições, todas precisam ser atendidas.
4. Em **ENTÃO**, adicione as ações desejadas e revise sua ordem e os campos de configuração.
5. Clique em **Criar automação**. Ela nasce **Pausada**; revise antes de ligá-la.

O gatilho **Quando entrar um contato novo (webhook)** se refere à entrada por webhook. Não presuma que ele cubra toda criação manual ou toda conversa. Para reagir a uma mudança de etapa, escolha o gatilho correspondente e, se necessário, filtre a **Etapa de destino**.

Se uma ação envia mensagens ou avisa outro sistema, planeje um teste controlado com destinatário autorizado: ligar a regra pode produzir efeitos reais. Não use clientes reais como massa de teste.

## A automação não disparou

1. Confira o workspace e se a regra está **Ativa**.
2. Abra **Editar automação** e compare o evento ocorrido com o gatilho escolhido. Confira também todos os filtros e a configuração das ações.
3. Para entrada de formulário ou integração, consulte **Receber dados** e **Leads recebidos** para verificar se a entrada aparece no CRM.
4. Abra **Atividade** e use **Atualizar**. Leia o resultado e a explicação de cada ação.

**Sucesso** registra o resultado da execução; o detalhamento pode indicar que a confirmação de entrega ainda depende do canal. **Parcial** pede a leitura de cada ação. **Falhou** informa que houve falha. **Aguardando envio** pode envolver horário ou disponibilidade do canal; use o motivo apresentado, sem assumir uma causa só pelo título.

## Motivos que a tela pode mostrar

- Contato sem telefone ou lead sem contato vinculado: revise o cadastro no próprio CRM.
- Configuração incompleta: revise os campos da ação.
- Agente sem versão publicada: revise sua publicação em **Agente de IA → Agentes**.
- Fora da janela de envio ou aguardando o canal: acompanhe a explicação e eventual próxima tentativa na atividade; confira **Conexões** quando indicado.
- Contato bloqueado, consentimento recusado ou contato anonimizado: respeite a restrição. Não crie outra regra para contorná-la.

Se houver dúvida sobre a entrega, confira a conversa antes de reenviar. Repetir a ação sem essa checagem pode duplicar uma mensagem.

## Quando pedir ajuda

Informe gatilho, tipo de ação, situação exibida e horário aproximado, com exemplos fictícios. Não envie o endereço completo do webhook, conteúdo de requisições, telefones ou mensagens de clientes. Se o evento está correto e o resultado permanece sem explicação, encaminhe o caso ao responsável pela instalação; o assistente não confirma o estado atual da sua operação apenas lendo este guia.
