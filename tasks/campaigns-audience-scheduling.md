# Campaigns Audience And Scheduling

- [x] Git status limpo, fetch origin e branch a partir de origin/main.
- [x] Ler AGENTS/CLAUDE e localizar CSV, telefone, upsert atomico, fuso, registry e event_log.
- [x] Preview paste/CSV/XLSX sem persistencia de arquivo bruto.
- [x] Migration 0219: publico congelado, contatos tenant-local e agendamento atomico.
- [x] UI tres modos, envio imediato/agendado e sidebar.
- [x] Testes de regressao, Postgres descartavel, typecheck, lint e diff check.

Decisoes: reutilizar normalizaTelefone/mapHeader/parseCsv/decodificarCsv,
fn_upsert_wa_contact e instanteDe. Preservar RPC 0218 para consumidores existentes.
Agendamento usa o mesmo evento whatsapp_campaign.requested e next_attempt_at;
nenhum timer no navegador e nenhuma fila nova.

Verificacao: 191 testes isolados, 22 testes PG e 2 jornadas de browser
(desktop/mobile) passaram. Typecheck, lint focado e release:conferir passaram.
0218 intacta e ambos os apendices comparados integralmente; varredura anon final.
Limitacoes: sem Docker no PATH, sem baseline completo/Supabase/WAHA reais;
browser usa API simulada. Suite global nao executada (setup carrega .env real).
Sem commit, push, PR ou acesso a producao. Evidencias e comandos em
docs/testing/campaigns-audience-scheduling.md.
