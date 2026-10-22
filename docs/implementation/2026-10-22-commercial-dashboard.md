# Dashboard comercial — contrato aprovado em 22/10/2026

Status: **em implementação; não liberar merge nem deploy deste trabalho**.

## Regras de produto

- Disponível em todos os workspaces; Dashboard será o primeiro destino lateral.
- Dados e credenciais separados por organização; preservar o escopo de leitura dos papéis existentes.
- Fechamento é primeiro pagamento confirmado; trial e negócio ganho sem confirmação não equivalem a pagamento.
- Escola registra manualmente valor, moeda, data e quantidade; o aplicativo Obra no Bolso envia confirmação pelo backend, sem nova integração bancária.
- Uma venda pode ter duas matrículas/unidades. Não duplicar o pagamento para contar unidades.
- Qualificação é a primeira entrada em uma etapa marcada pelo gestor, configurável pelas telas.
- Duas visões: primeiros pagamentos recebidos no período; retorno dos leads captados no período com compras posteriores.
- Confirmado pelo usuário: começar na ativação; não importar assinantes antigos. O aplicativo grava o instante da ativação em migration e exclui renovações, inclusive quando o usuário já tinha recebido pagamentos antes desse corte.
- Integração Facebook/Instagram: gasto por campanha, leads, qualificados, fechamentos, primeiro pagamento, custos em mídia e retorno.
- Sincronização horária e atualização manual; mostrar falta de dados, cobertura e horário de consulta.
- Não atribuir campanha por semelhança de nome, não confundir anúncio com clique, não misturar moedas ou presumir dados históricos.
- Regras de bronze/prata/ouro ficam para outra etapa.
- Painel de novidades fica para entrega futura: histórico de versões, funcionalidades planejadas/em desenvolvimento/entregues e um voto por usuário. Conteúdo global e edição somente pelo administrador da instalação.

## Entregas e pendências

- A correção de reenvio de mídias é independente: PR #44, mesclado após todos os checks passarem; deploy ainda pendente.
- Implementação inicial: contratos, cálculos, schema, APIs de consulta/configuração/pagamento e frontend; campanhas, links de origem, sincronização e cobertura diária; contrato v3 e outbox independentes no aplicativo.
- Testes de desenvolvimento executam as migrations reais em PostgreSQL embarcado, finanças, RLS, idempotência, corte de ativação, parser e leitura da Meta. Não substituem o baseline completo, testes multiconexão ou E2E.
- Ainda concluir/revisar: visibilidade operacional de falhas de identidade e do outbox, arquivos de tipos gerados, matriz completa de API/RLS, E2E e QA visual, documentação e revisões finais.
- O cadastro via site exige que crm_ref chegue ao frontend do aplicativo. Redirecionamentos externos da landing page/checkout precisam ser homologados; não presumir atribuição onde o código se perdeu.
- Antes dos testes finais: refletir a migration completa no baseline, manter manifest e documentação atualizados, atualizar a branch com a main.
- Fazer duas revisões consecutivas sem defeitos acionáveis; depois validar as suítes locais, banco isolado, CI, E2E e build.
- Não incluir o PR 20. Não implementar o painel de novidades nesta entrega.
- Capacidade da VPS: a primeira consulta mostrou 99%/1 GB livre; a consulta mais recente, após a limpeza do usuário, mostrou 49%/34 GB livres. Nenhuma limpeza foi feita neste trabalho. Reavaliar espaço para imagens novas e rollback antes do deploy.

## Ordem de publicação futura

1. Finalizar revisão e testes de ambos os repositórios; nada deste dashboard foi mesclado ou publicado.
2. Publicar primeiro o receptor CRM (migrations 0238/0239 e interface), mantendo compatibilidade com v1/v2.
3. Publicar o aplicativo com migration de ativação, frontend que preserva crm_ref e worker/beat de eventos comerciais.
4. Confirmar cadastro e primeiro recebimento sintéticos no ambiente de homologação; depois validar origem real da campanha e o dashboard.
5. O evento financeiro não envia mensagens de WhatsApp. Para quem passou por trial, não antecipa a movimentação/boas-vindas prevista após 96 horas. Contratação sem trial pode avançar com recebimento confirmado.

Não usar este checkpoint como declaração de funcionalidade concluída ou validada.

## Revisão de implementação

- Anulação financeira usa o lock do contato e respeita anonimização.
- Pagamento externo divergente de registro manual gera conferência, não confirmação silenciosa.
- Soma monetária fora do inteiro exato é recusada; aliases do mesmo fuso são reconhecidos.
- Falha de sincronização aparece no dashboard e no diálogo de campanhas, preservando cache anterior.
- Tipos regenerados e baseline completo validados em banco isolado; os gates do commit atual seguem obrigatórios.

## Sistema vivo

- Entradas: WhatsApp/referral, links crm_ref, CRM manual e outbox v3 do aplicativo.
- Saídas: /app/dashboard e consumidor conversoes.venda em lib/conversoes/envio.handler.ts.
- Atividade: ações dashboard.* no audit; crm.first_payment_confirmed no event_log; falhas v3 em fn_reject_obra_access.
- Configuração: Configurar indicadores, Registrar pagamento e Vincular e sincronizar campanhas.
- Recuperação: leases/CAS, cache preservado e consulta manual; outbox faz retry com UUID estável. Dados inválidos voltam à fila automaticamente após correção no produto, com nova tentativa em até uma hora.
- Continuidade humana: registros manuais e correções exigem gestor; comprovante não é confirmação automática. Sem mensagem adicional ao lead.
- Retorno: falha preserva estado anterior e aparece para corrigir conexão/dados; correção financeira recalcula indicadores sem reenviar conversão já entregue.
- Mapa: docs/architecture/dashboard-comercial.architecture.json.

## Evidência anterior ao PR

- Banco descartável pg15 com baseline completo: install e update passaram; 10 testes de RLS/financeiro/qualificação/exclusão passaram.
- A primeira execução real revelou nome de evento inválido; corrigido para crm.first_payment_confirmed, sem alterar a constraint global.
- Testes selecionados: 213 passaram na primeira matriz e 54 passaram após as correções finais (conjuntos parcialmente sobrepostos).
- Typecheck e lint focado passaram. CI completo, E2E com captura e tipos gerados ainda pendentes.
- Aplicativo: 38 testes selecionados de comercial/96h/consulta, 3 testes comerciais após recuperação e 2 provas de PostgreSQL passaram.

## Segunda rodada do gate

- Tipos regenerados pelo Supabase do E2E isolado e typecheck aprovado com o arquivo gerado.
- O teste de upgrade histórico removia o intervalo entre 0222 e a varredura terminal: os novos blocos passam a ficar antes dessa varredura, preservada no fim. A regressão original, sem alteração do teste, passou nos quatro cenários PostgreSQL.
- IDs naturais de conta/campanha passam no metadata de auditoria, com resource_id nulo (a coluna é UUID).
- Catálogo de suporte revisado e regenerado; artigos de primeiros passos e navegação incluem o Dashboard.
- Build e testes do aplicativo no GitHub passaram; não mesclado, aguardando receptor CRM publicado e revisão final.

## Correções durante os gates

- Prova comportamental de cada uma das dez tabelas novas em dois workspaces, registrada no verificador de completude: 61 verificações passaram no PostgreSQL descartável.
- Interface usa o idioma da sessão, com traduções em espanhol e datas no fuso válido; navegação inclui Dashboard no início: 44 testes locais passaram.
- Catálogos que excedem o teto real do PostgREST são recusados, sem ocultar etapas silenciosamente. Fuso inválido degrada ao padrão no diálogo de campanhas: 9 verificações de API passaram.
- Merge e deploy continuam condicionados ao CI/E2E do commit final e à revisão de integração.

## Correções do E2E

- A preparação do teste criava etapas em lote com chaves diferentes; PostgREST enviava is_won nulo na primeira linha. Os dois registros agora declaram is_won/is_lost explicitamente.
- O novo grupo excedia a dobra do menu de 900px. Dashboard permanece primeiro; Desempenho e Meta Ads ficam no hub de Análise e na busca, sem reduzir alvos de clique. O teste mantém a exigência de não rolar e verifica a nova ordem.
- Uma prova isolada dos três cenários precede a bateria completa, que mantém os mesmos arquivos e verificações. A segunda parte do E2E anterior passou.
