---
impacto: nada_mudou
secao: corrigido
titulo: Instalador usa as imagens deste repositório e backup identifica o volume real do WhatsApp
---

O instalador e a consulta de versões usam o repositório deste fork, e as três
imagens do CRM apontam para o seu publicador. O backup de sessões WhatsApp lê o
mount do contêiner existente, inclusive com nomes de projeto contendo hífens ou
volumes personalizados. Um mount ausente, vazio ou um arquivo inválido faz o backup
falhar explicitamente, em vez de confirmar um snapshot vazio.
