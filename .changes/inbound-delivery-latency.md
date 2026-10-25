---
impacto: nada_mudou
secao: corrigido
titulo: Esperas do serviço deixam de prender o envio por tempo indefinido
---

O envio do agente podia permanecer esperando consultas ou assinatura de mídia no
Supabase durante minutos, mantendo o canal ocupado. Consultas do serviço agora
têm prazo e não acumulam retentativas HTTP ocultas. A preparação e o pós-envio
também têm orçamentos de espera independentes do transporte do arquivo.

O diagnóstico registra tempos de preparação, transporte e reconciliação por
tentativa, sem conteúdo ou credenciais. Uma entrega confirmada continua sem ser
reenviada; uma entrega incerta continua exigindo conferência. Uploads manuais de
mídia mantêm seu comportamento.
