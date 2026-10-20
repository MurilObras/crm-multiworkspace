# Elegibilidade e espera do acompanhamento

## Contrato

- `trigger_config.params.segments` e a condição `tag` leem **contacts.tags**.
- A etapa e os campos adicionais continuam vindo da oportunidade. Etiquetas de
  oportunidade não autorizam nem reativam o acompanhamento do contato.
- Os adapters `createPgAdminClient` e `createSupabaseAdminClient` aplicam o mesmo
  contrato, com filtro de organização nas duas consultas.
- `wait/fixed.send_window` é opcional. Define dias (domingo=0), início inclusivo,
  fim exclusivo (24 significa meia-noite seguinte) e fuso IANA válido. O motor
  soma a duração e ajusta ao primeiro instante permitido. Sem janela, o grafo
  antigo mantém o comportamento. O modo adaptativo continua sendo uma escolha da
  IA; a orientação em texto não é uma garantia mecânica de horário.
- A janela restringe **a saída da espera**. Não substitui as políticas de envio,
  cancelamento, bloqueio, atendimento humano ou a janela do canal. Trabalho
  posterior na fila pode atrasar a entrega; não equivale a promessa de entrega
  no minuto calculado.

## Evidências e validação

- `lib/followup/contact-tags.test.ts`: PostgreSQL embarcado, consultas reais dos
  dois adapters, caminho de condição, retirada da etiqueta, cartão com etiqueta
  antiga, contato sem oportunidade e isolamento por organização.
- `tests/invariants/followup-contact-tags.test.ts`: mesmos adapters no baseline
  completo, via `pnpm test:db`.
- `lib/followup/send-window.test.ts`: primeiro horário permitido, fim exclusivo,
  final de semana, horário de verão, retorno do worker e compatibilidade legada.
- `WaitForm.test.tsx` e caso de janela em `followup-builder.spec.ts`: configuração
  em tela, persistência após recarga e edição/desativação.

## Reteste após publicação

Primeiro confirmar que a versão nova está na VPS. Depois, no workspace correto:
conferir a etapa real do contato; não movê-lo artificialmente para evitar uma
regra. Para o primeiro retorno após um gatilho de silêncio de duas horas, usar a
espera fixa mínima de cinco minutos com dias/horários permitidos. Não somar mais
duas horas. Publicar o fluxo e verificar o vínculo com o agente publicado.

Inscrições existentes são pinadas: editar o fluxo não troca o plano delas. Para
retestar um contato autorizado, cancelar a inscrição anterior pela tela e
reinscrever pela entrada automática elegível, sem remover o histórico. Registrar
o novo ID, a versão, o horário calculado e o resultado de envio/entrega. Não
confundir configuração salva, agendamento, envio e entrega.

## Living System Checklist

Entrada: `contacts.tags`, relógio e configuração do nó. Saída: condição do motor
e `next_eval_at`, consumidos pelo tick/worker existentes. Atividade: eventos
`node_advanced`/`wait_started` e horários já exibidos no dossiê. Porta: Agente de
IA > Follow-ups > construtor e Fila > dossiê. Configuração: `WaitForm`; validação
Zod e aviso de campo inválido. Anti-morte: próxima avaliação persistida e fluxo
de falha do motor. Continuidade humana: pausar/cancelar/adiar pela Fila, sem
substituir atendimento humano. Retorno: horário e histórico observáveis permitem
corrigir a configuração e retestar; não há alteração automática de regras.
Mapa: `followup-dossie.architecture.json` descreve a origem das etiquetas e a
espera fixa configurável. Não há tabela nem migração nova.
