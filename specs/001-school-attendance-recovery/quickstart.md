# Quickstart — validação futura

**Execução local autorizada após revisão.** Sem produção, mensagens a leads, merge ou deploy. Homologação por WhatsApp da versão nova permanece posterior à publicação.

## Ambiente

Cópia isolada com banco efêmero e dois workspaces sintéticos. Nenhuma suíte aponta a produção. Conta, sessão WhatsApp e credencial de testes sem segredos em logs. Node 22, pnpm 9.15.9. Contato de teste confirmado antes da homologação real.

## Jornadas

1. **Opção desmarcada:** enviar “vou verificar”; caso permanece aberto e controle não muda por causa desse envio.
2. **Opção marcada:** enviar texto, confirmar transporte, conferir consulta resolvida e nova pergunta atendida. Repetir com áudio.
3. **Falha/espera:** para texto e áudio separadamente, sessão desconectada, erro e entrega incerta não concluem caso prematuramente; latência do upload/transporte de áudio não libera o agente antes da confirmação.
4. **Crash/repetição:** transporte confirma antes de falha na resolução; recuperação não reenvia resposta nem duplica transição.
5. **Nova decisão humana:** outro atendente assume/pausa antes da aplicação; preservar decisão e explicar bloqueio.
6. **Outra consulta:** resolver uma entre duas; identificar pendência restante, sem concluir todas.
7. **Silêncio:** encerramento interno não envia nem libera resposta antiga preparada; transporte iniciado/incerto produz conflito claro.
8. **Agendamento:** aceitar aula compatível, persistir ficha/etapa/etiquetas e recarregar. UUID incorreto do modelo não altera vínculo; retry não duplica oportunidade.
9. **Pagamento:** mudar finalidade com inscrição ativa, pausada e cancelada. Passagem só quando autorizada; sem dois fluxos vivos/repetição. Relógio controlado cobre noite, sexta e fim de semana.
10. **Áudio:** comparar conteúdo ouvido e interpretação em áudio novo/cópia histórica. Falha real vai ao coordenador sem interpretação inventada, mensagem genérica ou aviso duplicado. Reprocessar histórico não responde ao lead.
11. **Isolamento:** IDs de outra organização e papel insuficiente não leem/alteram dados; repetir durante recuperação de crash/replay e tentativa de relink, sem consumir evento ou resolver consulta alheia.
12. **Mobile:** escolher caso, enviar áudio e acompanhar estados sem sobreposição ou controles inacessíveis.

## Comandos futuros

Após implementação/revisão: `pnpm typecheck`, `pnpm lint`, `pnpm lint:channels`, `pnpm lint:role-rank`, `pnpm test:unit`, `pnpm build`. Banco/RLS: `pnpm test:db` quando aplicável. UI: `pnpm test:e2e` nas jornadas e demais checks obrigatórios reais antes de PR.

Não declarar verde amplo com recorte isolado. Guardar resultados completos e nomes de falhas. Capturas com dados pessoais ficam fora do Git. WhatsApp somente no contato autorizado, aquecimento preservado; nunca usar lead real.
