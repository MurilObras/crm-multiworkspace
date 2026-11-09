# Correções de atendimento da escola

**Data:** 09/11/2026. **Status:** bloco de código implementado, revisado e validado localmente. Configuração operacional e homologação real permanecem pendentes. Sem merge ou deploy.
**Branch:** `fix/school-handoff-audio-followups`. **Base:** `origin/main` em `9a2f2808` (3.10.1).

## Leitura recomendada

1. [Diagnóstico dos seis pontos](assessment.md).
2. [Requisitos e critérios de aceite](spec.md).
3. [Plano por blocos](plan.md).
4. [Tarefas e estado da execução](tasks.md).
5. [Roteiro de validação](quickstart.md).
6. [Decisões e evidências](research.md).
7. [Contratos](contracts/attendance.md) e [modelo de dados](data-model.md).
8. [Revisão do planejamento](analysis.md).

## Método e limites

Na primeira elaboração, foram consultados os modelos do [GitHub Spec Kit](https://github.com/github/spec-kit), revisão `a60bd9bad5af2d25df42188330e8281f2dd1c8bb`, sem inicializar integração. Após o pedido de usar PROGRAME, o CLI oficial já instalado inicializou a integração Codex neste checkout e seus scripts reconheceram os documentos existentes, sem sobrescrevê-los. A constituição importa a doutrina do projeto, sem criar regras concorrentes. A autorização posterior iniciou a implementação pelas tarefas deste diretório; o histórico documental anterior foi preservado.

O fluxo atual é [PROGRAME](programe.md): Spec Kit para planejamento; Superpowers para diagnóstico, TDD, revisão e evidências. Graphify já apoiou a investigação com AST local de `lib/`, 6.113 nós e 14.110 relações; não abrange o frontend inteiro. Caveman preserva concisão. A revisão Plandex anterior consta em `analysis.md` como evidência histórica; não será um segundo condutor das próximas revisões.

Limites atuais: implementação e testes locais autorizados; nenhuma alteração de configuração ou dados de produção, reprocessamento histórico, mensagem a leads, merge ou deploy. Os testes usam dados sintéticos e banco isolado. Homologação semântica de áudio e configuração operacional de acompanhamentos permanecem explícitas em `tasks.md` e `analysis.md`. Dados reais e diagnósticos brutos ficam fora do Git. O PR 20 não integra o escopo.
