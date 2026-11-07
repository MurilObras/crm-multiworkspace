# Evidências de follow-up — 07/11/2026

Capturas de uma execução local de Chromium contra banco descartável, com dados sintéticos. Os 13 cenários dos cinco arquivos E2E selecionados passaram sem retries. Não houve WhatsApp nem chamada real de modelo nesses cenários.

- [Retomada após resposta](retomada-apos-resposta.png): a linha do tempo mostra interrupção e continuação da mesma espera fixa. Esta imagem prova apresentação e continuidade; não comprova o replanejamento adaptativo.
- [Plano de tempo](plano-de-tempo.png): a tela mostra a proposta, o limite aplicado e o motivo do plano adaptativo. O resultado do modelo é injetado no seam de produção; não representa uma escolha de um modelo real.

A regressão do plano anterior à nova mensagem é exercitada no PostgreSQL real por `tests/invariants/adaptive-reminder-replanning.test.ts`. O turno completo de cancelamento e a reconciliação da próxima ação estão em `tests/invariants/checkpoint-next-action-sync.test.ts`. A homologação dessas duas correções no WhatsApp depende da publicação da branch em ambiente autorizado.
