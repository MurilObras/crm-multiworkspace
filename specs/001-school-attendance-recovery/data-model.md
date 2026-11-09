# Data Model — fontes atuais e transições propostas

Status: implementado em branch local pela migration 0247; não publicado. Intenções ficam separadas dos metadados editáveis da mensagem.

| Entidade existente | Papel | Invariante |
|---|---|---|
| `agent_cases` | Consulta à equipe/cliente | Terminal não significa mensagem enviada. Vínculo de conversa e organização obrigatório. |
| `agent_case_events` | Decisão e histórico | Ator real; IA não inventa decisão humana. |
| Pedidos/entregas de responsável | Consulta e transporte ao coordenador | Aviso lido não resolve consulta. |
| `messages` | Resposta humana e confirmação | Bolha/HTTP/fila não substituem confirmação do transporte. |
| `conversations` / `contacts` | Dono, pausa, bloqueio, autorização | Retomada não apaga opt-out ou controle humano posterior. |
| `crm_leads` / `crm_stages` | Oportunidade e etapa | Vínculo de contato não muda para editar agendamento. |
| Inscrições/eventos de follow-up | Acompanhamento vigente | Um vivo por contato; respeitar pausa e cancelamento humanos. |

## Intenção associada ao envio

Fonte implementada: `case_resolution_intents`, privada para escrita de serviço e vinculada à mensagem/caso/conversa/contato/org. Guarda autor, revisões de comando, estado, confirmação e resultado. `conversations.ai_control_revision` e `contacts.ai_control_revision` mudam em decisões de comando; relógio/preview não invalidam a decisão. O autor pode ser removido sem apagar o histórico, impedindo a liberação posterior sem acesso válido.

Consulta selecionada, identidade da mensagem, ator humano, pedido explícito de retorno e estado de aplicação do efeito. Organização/conversa/contato são derivados e validados pelo servidor, não autoridades fornecidas pelo navegador.

Preferir metadado estruturado na mensagem, com leitor/escritor compartilhados e consumo durável. Antes de patch, confirmar se persistência atual permite idempotência, concorrência e auditoria suficientes; caso contrário, propor schema mínimo com migration, baseline, MANIFEST e teste de duas organizações.

## Transições

- Mensagem preparada/em fila/falha/incerta: consulta permanece aberta.
- Transporte confirmado + intenção válida: consulta selecionada resolve uma vez; pedido externo encerra; devolver à IA somente sem bloqueio restante/controle humano posterior.
- Consulta resolvida por outra via durante envio: não duplicar resolução nem presumir autorização de retomada.
- Encerramento interno: resolve sem criar envio/turno de resposta.
- Experimental para pagamento: trocar finalidade da inscrição por operação explícita e elegível; não ressuscitar cancelamento humano.
