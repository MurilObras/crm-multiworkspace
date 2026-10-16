"use client";
/**
 * TestPanel — dry-run de uma version (S-13.12).
 *
 * Envia sample message via POST `:test` (admin-only). Renderiza trace +
 * "Mensagem que SERIA enviada". Não toca WAHA, não cria messages.outbound.
 * Quando `INTERNAL_AGENT_RUN_STUB=true` o backend devolve trace stub com
 * `stub: true`; o componente mostra um aviso amigável.
 */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { agentRunsKey } from "@/hooks/ai/useAgentRuns";
import { useT } from "@/hooks/i18n/useT";
import type { AgentRow } from "@/hooks/ai/useAgent";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

import { RunTrace } from "./RunTrace";

interface Props {
  agent: AgentRow;
  draft: AgentVersionRow | null;
  published: AgentVersionRow | null;
  readOnly?: boolean;
}

interface TestResponse {
  data: {
    run_id: string;
    status: string;
    final_text?: string | null;
    tool_calls?: unknown;
    tokens_in?: number;
    tokens_out?: number;
    cost_cents?: number | null;
    latency_ms?: number;
    would_send_to?: { session?: string | null; chat_id?: string | null };
    stub?: boolean;
    messages?: string[];
    runtime?: string;
    limitations?: Array<{ gate: string; porque: string }>;
    gates?: Array<{ gate: string; pass: boolean; code?: string }>;
    /** Ver lib/ai/agents/avaliar-resposta-de-teste.ts. */
    guardrails?: {
      passou: boolean;
      semResposta?: boolean;
      categorias: string[];
      termos: string[];
      naoAvaliados: Array<{ gate: string; porque: string }>;
    };
  };
}

/** Texto aprovado e limites explícitos. O ensaio não confirma efeitos externos. */
function Verificacoes({ g }: { g: NonNullable<TestResponse["data"]["guardrails"]> }) {
  const t = useT();
  return (
    <div className="space-y-2" data-testid="teste-verificacoes">
      {g.semResposta ? (
        <p className="text-xs text-muted-foreground">
          {t("Não houve resposta final para avaliar neste ensaio.")}
        </p>
      ) : g.passou ? (
        <p
          data-testid="teste-vazamento-limpo"
          className="rounded-md border border-border/60 bg-muted/40 p-2 text-xs"
        >
          {t("A resposta não usa palavras internas do sistema.")}
        </p>
      ) : (
        <div
          data-testid="teste-vazamento-achado"
          className="rounded-md border border-destructive/50 bg-destructive/5 p-2 text-xs"
        >
          <p className="font-medium text-destructive">
            {t("Esta resposta usa palavras que o cliente não deveria ver.")}
          </p>
          <p className="mt-1 text-muted-foreground">
            {t("Em produção ela seria barrada e o assistente teria que reescrever. Encontrado:")}{" "}
            <span className="font-mono">{g.termos.join(", ")}</span>
          </p>
        </div>
      )}

      {/*
        A lista do que NÃO foi checado. Ela é o que separa este conserto de uma
        mentira mais bonita: as verificações que dependem do turno real não podem
        ser avaliadas aqui, e inventá-las daria um veredito com aparência de
        prova. O usuário precisa saber a diferença entre "passou em tudo" e
        "passou no que dava para checar sem uma conversa de verdade".

        (O texto dizia "os seis gates" enquanto a lista renderizava nove — número
        que já foi verdade para um subconjunto e envelheceu. A contagem agora sai
        da própria lista, logo abaixo, e não de prosa.)

        Esta lista responde "o que este teste NÃO checou"; a aba "Confere antes de
        enviar" responde "o que é checado, e o que cada uma protege". São
        perguntas diferentes, e por isso há um ponteiro em vez de uma cópia — as
        duas saem da mesma cadeia, cada uma com o seu teste de casamento.
      */}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer" data-testid="teste-nao-verificado">
          {t("O teste não consegue verificar tudo (")}
          {g.naoAvaliados.length} {t("verificações ficam de fora)")}
        </summary>
        <ul className="mt-2 space-y-1 pl-4">
          {g.naoAvaliados.map((n) => (
            <li key={n.gate}>— {n.porque}</li>
          ))}
        </ul>
        <p className="mt-2">
          {t(
            "As verificações omitidas e as ações simuladas não comprovam o atendimento completo. Para ver as proteções do envio real, abra a aba",
          )}{" "}
          <span className="font-medium text-foreground">{t("Confere antes de enviar")}</span>.
        </p>
      </details>
    </div>
  );
}

export function TestPanel(props: Props) {
  return (
    <ConversationTestPanel
      key={`${props.agent.id}:${(props.draft ?? props.published)?.id ?? "none"}`}
      {...props}
    />
  );
}

function ConversationTestPanel({ agent, draft, published, readOnly }: Props) {
  const t = useT();
  const target = draft ?? published;
  const qc = useQueryClient();

  const [message, setMessage] = React.useState("");
  const [contactName, setContactName] = React.useState("");
  const [contactPhone, setContactPhone] = React.useState("");
  const [history, setHistory] = React.useState<
    Array<{ direction: "inbound" | "outbound"; body: string }>
  >([]);
  const [pending, setPending] = React.useState(false);
  const [result, setResult] = React.useState<TestResponse["data"] | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);

  if (!target) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("Configure e salve uma versão antes de testar.")}
      </p>
    );
  }

  const versionLabel =
    target.status === "published"
      ? `v${target.version_number} ${t("(publicada)")}`
      : `v${target.version_number} ${t("(rascunho)")}`;

  async function handleRun() {
    if (!message.trim()) {
      toast.error(t("Informe uma mensagem de teste."));
      return;
    }
    if (!target) return;
    setPending(true);
    setResult(null);
    setRunError(null);
    try {
      const body: Record<string, unknown> = {
        sample_message: message.trim(),
        sample_history: history,
      };
      if (contactName.trim() || contactPhone.trim()) {
        body.sample_contact = {
          ...(contactName.trim() ? { name: contactName.trim() } : {}),
          ...(contactPhone.trim() ? { phone: contactPhone.trim() } : {}),
        };
      }
      const res = await apiClient.post<TestResponse>(
        `/api/v1/ai/agents/${agent.id}/versions/${target.id}/test`,
        body,
        { timeoutMs: 120_000, maxAttempts: 1 },
      );
      setResult(res.data);
      if (!res.data.stub) {
        const replies = (res.data.messages ?? []).map((body) => ({
          direction: "outbound" as const,
          body,
        }));
        setHistory((previous) =>
          [...previous, { direction: "inbound" as const, body: message.trim() }, ...replies].slice(
            -40,
          ),
        );
      }
      toast.success(t("Teste executado."));
    } catch (err) {
      const message =
        err instanceof ApiError
          ? t(err.message)
          : t(
              "Não foi possível obter o resultado. Confira a aba Execuções antes de executar outro teste.",
            );
      setRunError(message);
      if (err instanceof ApiError) {
        toast.error(t(err.message) || `${t("Erro")}: ${err.code}`);
      } else {
        toast.error(t("Erro inesperado."));
      }
    } finally {
      qc.invalidateQueries({ queryKey: agentRunsKey(agent.id) });
      setPending(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("Versão alvo")}
          </p>
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="outline">{versionLabel}</Badge>
            <span className="font-mono text-xs">
              {target.provider} / {target.model}
            </span>
          </div>
        </div>

        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <p className="font-medium text-amber-700 dark:text-amber-400">
            {t("⚠ Modo teste consome créditos do provider.")}
          </p>
          <p className="mt-1 text-muted-foreground">
            {t(
              "O teste usa o contexto e a chamada de IA do Conversador, com conhecimento, skills e memória do workspace. Nenhuma mensagem é enviada e nenhuma ação é executada no CRM.",
            )}
          </p>
        </div>

        <div
          className="space-y-2 rounded-md border p-3 text-xs"
          data-testid="test-conversation-history"
        >
          <p>
            {t(
              "Cliente fictício. O histórico desta simulação continua entre os testes; não usa dados nem memória individual de contatos reais.",
            )}
          </p>
          {history.map((m, i) => (
            <p key={i} className="whitespace-pre-wrap">
              <strong>{m.direction === "inbound" ? t("Cliente: ") : t("Agente: ")}</strong>
              {m.body}
            </p>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={pending || readOnly || (!history.length && !result && !runError)}
            onClick={() => {
              setHistory([]);
              setResult(null);
              setRunError(null);
              setMessage("");
            }}
          >
            {t("Nova conversa de teste")}
          </Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor="test-message">{t("Mensagem do cliente (sample)")}</Label>
          <Textarea
            id="test-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("Oi, quanto custa X?")}
            rows={4}
            disabled={pending || readOnly}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-2">
            <Label htmlFor="test-name">{t("Nome (opcional)")}</Label>
            <Input
              id="test-name"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="Maria"
              disabled={pending || readOnly}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="test-phone">{t("Telefone (opcional)")}</Label>
            <Input
              id="test-phone"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="+55..."
              disabled={pending || readOnly}
            />
          </div>
        </div>

        <Button onClick={handleRun} disabled={pending || readOnly} className="self-start">
          {pending ? t("Executando…") : t("Executar teste")}
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("Resultado")}
        </p>

        {runError ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 p-3 text-sm text-destructive"
          >
            {runError}
          </p>
        ) : null}
        {!result && !pending && !runError ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum teste executado ainda.")}</p>
        ) : null}

        {pending ? (
          <p className="text-sm text-muted-foreground">{t("Executando dry-run…")}</p>
        ) : null}

        {result ? (
          <>
            {result.stub ? (
              <p className="rounded-md border border-border/60 bg-muted/40 p-2 text-xs text-muted-foreground">
                {t(
                  "Modo de demonstração: o modelo não foi chamado. O resultado abaixo é fabricado para testar a tela.",
                )}
              </p>
            ) : null}

            <div className="grid grid-cols-2 gap-2 text-xs">
              <Cell label={t("Status")}>{result.status}</Cell>
              <Cell label={t("Latência")}>
                {typeof result.latency_ms === "number" ? `${result.latency_ms}ms` : "—"}
              </Cell>
              <Cell label={t("Tokens in/out")}>
                {(result.tokens_in ?? 0).toLocaleString()} /{" "}
                {(result.tokens_out ?? 0).toLocaleString()}
              </Cell>
              <Cell label={t("Custo (cents)")}>{result.cost_cents ?? "—"}</Cell>
            </div>

            {result.runtime ? (
              <p className="text-xs" data-testid="test-runtime">
                {t(
                  "Ensaio do Conversador. Consulte abaixo o que foi simulado e o que exige WhatsApp real.",
                )}
              </p>
            ) : null}
            {result.status === "aborted" ? (
              <p className="text-xs text-destructive">
                {t(
                  "O turno não foi concluído nesta simulação. Confira as mensagens aprovadas, as tentativas e os vetos abaixo.",
                )}
              </p>
            ) : null}
            {result.status === "handoff" ? (
              <p className="text-xs">
                {t(
                  "O pedido interromperia o atendimento automático. Nenhum encaminhamento real foi feito.",
                )}
              </p>
            ) : null}
            {result.messages?.length ? (
              <div data-testid="test-message-bubbles" className="space-y-2">
                {result.messages.map((text, i) => (
                  <p key={i} className="rounded-md border p-2 text-sm whitespace-pre-wrap">
                    {text}
                  </p>
                ))}
              </div>
            ) : null}
            {result.gates?.length ? (
              <details className="text-xs">
                <summary>{t("Verificações realizadas neste ensaio")}</summary>
                {result.gates.map((g, i) => (
                  <p key={i}>
                    {g.gate}: {g.pass ? t("passou") : g.code}
                  </p>
                ))}
              </details>
            ) : null}
            <RunTrace
              toolCalls={result.tool_calls}
              finalText={result.messages?.length ? null : (result.final_text ?? null)}
              emptyMessage={t("Sem tool calls (resposta direta do LLM).")}
            />

            {result.guardrails ? <Verificacoes g={result.guardrails} /> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border/60 px-2 py-1">
      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="font-mono">{children}</p>
    </div>
  );
}
