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

- A correção de reenvio de mídias é independente: PR #44, validação em andamento.
- Implementação inicial: contratos, cálculos, schema, APIs de consulta/configuração/pagamento e frontend; campanhas, links de origem, sincronização e cobertura diária; contrato v3 e outbox independentes no aplicativo.
- Testes de desenvolvimento executam as migrations reais em PostgreSQL embarcado, finanças, RLS, idempotência, corte de ativação, parser e leitura da Meta. Não substituem o baseline completo, testes multiconexão ou E2E.
- Ainda concluir/revisar: visibilidade operacional de falhas de identidade e do outbox, arquivos de tipos gerados, matriz completa de API/RLS, E2E e QA visual, documentação e revisões finais.
- O cadastro via site exige que crm_ref chegue ao frontend do aplicativo. Redirecionamentos externos da landing page/checkout precisam ser homologados; não presumir atribuição onde o código se perdeu.
- Antes dos testes finais: refletir a migration completa no baseline, manter manifest e documentação atualizados, atualizar a branch com a main.
- Fazer duas revisões consecutivas sem defeitos acionáveis; depois validar as suítes locais, banco isolado, CI, E2E e build.
- Não incluir o PR 20. Não implementar o painel de novidades nesta entrega.
- Capacidade da VPS: a primeira consulta mostrou 99%/1 GB livre; a nova consulta mostrou 86%/9 GB livres. Nenhuma limpeza foi feita neste trabalho. Reavaliar espaço para imagens novas e rollback antes do deploy.

## Ordem de publicação futura

1. Finalizar revisão e testes de ambos os repositórios; nada deste dashboard foi mesclado ou publicado.
2. Publicar primeiro o receptor CRM (migrations 0238/0239 e interface), mantendo compatibilidade com v1/v2.
3. Publicar o aplicativo com migration de ativação, frontend que preserva crm_ref e worker/beat de eventos comerciais.
4. Confirmar cadastro e primeiro recebimento sintéticos no ambiente de homologação; depois validar origem real da campanha e o dashboard.
5. O evento financeiro não envia mensagens de WhatsApp. Para quem passou por trial, não antecipa a movimentação/boas-vindas prevista após 96 horas. Contratação sem trial pode avançar com recebimento confirmado.

Não usar este checkpoint como declaração de funcionalidade concluída ou validada.
