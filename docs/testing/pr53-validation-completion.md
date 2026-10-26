# Complemento de homologação do PR 53

## Causas confirmadas

O Realtime avaliava políticas privadas de leitura também para `PUBLIC`.
Uma inscrição anônima invocava helpers cujo EXECUTE é corretamente privado;
`realtime.apply_rls` abortava o lote com erro de permissão e a inscrição
autenticada perdia o evento, embora a assinatura aparecesse como ativa.

A reprodução HTTP/WebSocket isolada, com assinantes anônimo e autenticado,
recebeu zero eventos no autenticado antes da migration 0241 e exatamente um
depois. O anônimo recebeu zero nos dois casos. O E2E também falhou no frame
esperado antes da migration e passou depois dela. Nenhum helper ganhou EXECUTE.

No onboarding, mostrar um QR já criava uma sessão. Ao clicar em pular, a
escolha ficava no estado, mas a publicação ignorava essa escolha e selecionava
a sessão pendente. A falta de chave era consequência dessa tentativa indevida
de publicar; não era necessário fornecer uma chave real para concluir o
rascunho. O teste antigo também exigia publicação nesse passo e rascunho no
seguinte, condições incompatíveis.

## Correção e cobertura

- Migration 0241 e apêndice idempotente no baseline restringem os destinatários
  das políticas privadas de SELECT/ALL. Preservam predicados, papéis explícitos
  e os limites entre organizações, sem grants anônimos ou alteração de dados.
- `publishFirstVersion` respeita a escolha de pular a conexão. Leitura falha não
  autoriza publicar; ponteiro já publicado não é desfeito pela reentrada.
- `realtime-private-policies.test.ts` prova leitura anônima negada sem erro de
  helper, membro autenticado com sua conversa/mensagem e isolamento entre duas
  organizações. Negação no GRANT da tabela continua válida e não foi removida.
- `inbox-tempo-real.spec.ts` exige JWT do membro no join da conversa e frame
  real da mensagem no WebSocket, com inscrição anônima simultânea. Um refetch
  ou mudança de foco não satisfaz essa prova, mesmo que a bolha apareça.
- `vps-fresh-onboarding.spec.ts` percorre QR, escolha de pular, criação do
  rascunho, convite sem e-mail configurado, Inbox e cadastro/prova de MFA pelas
  telas. Não apresenta um rascunho como agente publicado ou IA operacional.

## Resultados locais

- Typecheck e lint dos arquivos alterados aprovados; conferência de release
  executada sem escrever versão/tag ou publicar.
- 43 casos em quatro arquivos unitários relacionados e 22 casos das cercas de
  cobertura/baseline aprovados. A fixture da reentrada foi corrigida para ter
  o `organization_id` que a consulta real exige.
- Baseline install/update em pg15 descartável e 50 invariantes de políticas
  privadas/isolamento aprovados, incluindo os dois tenants e os helpers sem
  permissão anônima. Permissões de tabela já revogadas continuaram revogadas.
- Build local Webpack aprovado no diretório descartável de QA; ajustes de
  memória/source maps são somente desse ambiente. O CI usa o build padrão.
- Instalação nova: **13 cenários aprovados**, sem casos pulados, incluindo a
  etapa de funil atual, convite por link, códigos de recuperação e novo login
  com MFA. Os seletores antigos foram adequados aos rótulos atuais e ao modal,
  mantendo a prova de estado real no banco e sem alterar o produto para o teste.
- Inbox: **três rodadas seguidas aprovadas** com a inscrição anônima paralela.
  O teste voltou à PARTE_1 obrigatória do E2E, com captura de tela como artifact.
- Revisão posterior dos ajustes sem nova falha identificada neste escopo. As
  suítes completas e ambas as partes do E2E serão repetidas no CI do novo HEAD.

Não há chaves reais de IA/e-mail ou número WhatsApp conectado no QA. O caminho
de instalação validado pula o WhatsApp e conclui um **rascunho**; não é prova de
resposta de um agente publicado a um cliente real. Não houve merge ou deploy.

## Living System Checklist

1. Entrada: papéis das inscrições Realtime e `onboarding_state.whatsapp.skipped`.
2. Saída: `realtime.apply_rls` → `useRealtimeChannel` → `useMessagesRealtime`
   → Inbox; `createDefaultAgent` → estado do wizard → tela de ensaio.
3. Registro: logs existentes do Realtime e eventos/auditoria de onboarding.
4. Tela: mensagem aparece em `/app/inbox`; rascunho é explicado em `/onboarding/testar`.
5. Porta: Inbox e wizard já presentes na navegação.
6. Anti-morte: reconexão/refetch de segurança existentes continuam ativos;
   rascunho pode ser configurado e publicado depois pelas telas existentes.
7. Configuração: associação de usuários e escolha de pular já têm superfície;
   política privada é invariante estrutural, sem novo botão de permissão.
8. Continuidade: pausas humanas e sequência de follow-up não foram alteradas.
9. Retorno: evento entregue invalida a consulta e atualiza a conversa; falha de
   leitura impede publicação e mantém a explicação existente para o operador.
10. Mapa: este fluxo complementa `outbound-delivery-latency.md` na arquitetura.
