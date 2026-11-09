<!--
Sync Impact Report
Version: scaffold sem versão -> 1.0.0
Importação de princípios existentes de AGENTS.md/CLAUDE.md, sem alterar a doutrina.
Adicionados: roteamento PROGRAME e limite vigente de planejamento.
Removidos: exemplos não preenchidos do template. Nenhum template upstream alterado.
Data abaixo registra adoção no Spec Kit, não a data histórica da doutrina do CRM.
-->
# CRM Constitution

## Core Principles

### I. Isolamento e autorização

Toda operação tenant-aware DEVE usar organização de fonte confiável e conferir RBAC.
Service role não dispensa filtro por organização. Backend usa getUser(). Dados reais,
credenciais e transcrições não entram no Git nem em logs públicos. Fontes: AGENTS.md e
CLAUDE.md, seções de multi-tenancy, auth e segurança.

### II. Estado verdadeiro e efeitos rastreáveis

Não apresentar fila/intenção como efeito concluído. Mutação relevante DEVE ter auditoria;
evento DEVE ter consumidor real. Respeitar fontes canônicas de identidade, estágio,
controle humano e acompanhamento. Repetição não duplica envio. Fontes: CLAUDE.md,
idempotência, anti-patterns e Definition of Done.

### III. Evolução de banco portável

Não editar migration aplicada. Schema exige migration nova, baseline idempotente,
MANIFEST, permissões mínimas e tipos gerados quando aplicáveis. Validar instalação,
atualização e isolamento. Fontes: doutrina de migrations em CLAUDE.md e AGENTS.md.

### IV. Verificar antes de concluir

Não declarar corrigido/pronto sem evidência atual. Estáticos, suíte unitária completa,
banco/RLS quando aplicável e E2E visual devem cobrir o patch. Recorte isolado não é suíte
ampla; registrar falhas e limitações. Fontes: comandos/validação em AGENTS.md e QA/DoD
em CLAUDE.md.

### V. Preservação e limites explícitos

Preservar alterações, instruções e decisões do usuário. Atualizar base antes de implementar,
sem reset destrutivo nem sobrescrita de trabalho alheio. Framework não autoriza instalação,
serviço externo, envio de dados/mensagens, mudança de acesso, merge ou deploy além do pedido.
Fontes: higiene de branches do projeto e instrução vigente do usuário.

## Processo de programação

PROGRAME roteia para originais: Spec Kit planeja; Superpowers conduz diagnóstico, TDD,
revisão e verificação. Graphify apoia relações/impacto. Agency fornece especialistas
proporcionais sem outro coordenador. Claude-Mem local guarda decisões verificadas;
Caveman orienta concisão. Não executar frameworks equivalentes para a mesma etapa.
Parecer Plandex anterior é evidência histórica, não segunda revisão obrigatória concorrente.

## Limite vigente desta entrega

Em 09/11/2026 o usuário autorizou implementar as correções planejadas e executar o ciclo
de revisão/correção e testes. Alterações operacionais em produção, mensagens a leads,
merge e deploy continuam fora do escopo. PR 20 não integra esta execução. Fechar os
bloqueadores técnicos antes dos patches dependentes; aplicar a PROGRAME atualizada.

## Governance

Este registro espelha AGENTS.md e CLAUDE.md e não substitui seus textos integrais. Instruções
vigentes do usuário preservam precedência. Alteração material de princípio exige justificativa
e decisão explícita; não flexibilizar princípios para aprovar uma feature. Usar versionamento
semântico e conferir conformidade no plano/revisão com artefatos e evidências concretos.

**Version**: 1.0.0 | **Ratified**: 2026-11-09 | **Last Amended**: 2026-11-09
