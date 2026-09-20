---
impacto: capacidade_nova
secao: adicionado
titulo: Entrada dedicada Kiwify com autenticação obrigatória e registro transacional
---

Cadastro por API de loja e produtos explicitamente permitidos, assinatura Kiwify
obrigatória e identidade durável de pedidos. Somente compra aprovada e paga pode
gerar lead; sem telefone válido não é emitido evento de automação. A implantação
depende da migration 0220 e da validação dos invariantes PostgreSQL. Esta entrega
não homologa o envio WhatsApp nem oferece replay de mensagens.
