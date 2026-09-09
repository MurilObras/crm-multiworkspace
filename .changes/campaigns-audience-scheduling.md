---
impacto: capacidade_nova
secao: adicionado
titulo: Campanhas com listas de numeros, planilhas e agendamento
---

Campanhas WhatsApp aparece no menu lateral e aceita numeros colados ou arquivos
CSV/XLSX, alem do publico por tag e origem. O preview mostra validos, unicos,
duplicados e invalidos antes de confirmar. Contatos novos sao criados no workspace
da campanha, sem guardar o arquivo original.

O envio pode ser imediato ou agendado com data, hora e fuso explicitos. O publico
fica congelado ao confirmar e o processamento ocorre no servidor, mesmo com o
navegador fechado, usando o scheduler e o worker existentes.
