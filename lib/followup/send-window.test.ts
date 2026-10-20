import { describe, expect, it } from "vitest";
import { nextInSendWindow, sendWindowSchema, type SendWindow } from "./send-window";
import { processNode, type EnrollmentRow, type LeadFacts } from "./node-handlers";
import { waitConfigSchema, type FlowNode } from "./graph-schema";

const window: SendWindow = {
  timezone: "America/Sao_Paulo",
  days: [1, 2, 3, 4, 5],
  start_hour: 8,
  end_hour: 20,
};
describe("janela explícita da espera", () => {
  it.each([
    ["2026-10-20T16:05:00-03:00", "2026-10-20T19:05:00.000Z"],
    ["2026-10-20T07:00:00-03:00", "2026-10-20T11:00:00.000Z"],
    ["2026-10-20T20:00:00-03:00", "2026-10-21T11:00:00.000Z"],
    ["2026-10-23T20:01:00-03:00", "2026-10-26T11:00:00.000Z"],
    ["2026-10-24T12:00:00-03:00", "2026-10-26T11:00:00.000Z"],
    ["2026-10-25T12:00:00-03:00", "2026-10-26T11:00:00.000Z"],
  ])("%s calcula %s sem IA", (input, expected) => {
    expect(nextInSendWindow(new Date(input), window).toISOString()).toBe(expected);
  });
  it("trata meia-noite como fim exclusivo quando a janela termina em 24h", () => {
    const w = { ...window, days: [0, 1, 2, 3, 4, 5, 6], start_hour: 0, end_hour: 24 };
    const date = new Date("2026-10-20T23:59:59.999-03:00");
    expect(nextInSendWindow(date, w)).toEqual(date);
  });
  it("usa a data civil e o offset do dia após a mudança de horário de verão", () => {
    const w = { ...window, timezone: "America/New_York" };
    expect(nextInSendWindow(new Date("2026-03-06T21:00:00-05:00"), w).toISOString()).toBe(
      "2026-03-09T12:00:00.000Z",
    );
  });
  it.each([
    { days: [] },
    { days: [1, 1] },
    { days: [7] },
    { timezone: "Invalido/Fuso" },
    { start_hour: 20, end_hour: 8 },
    { start_hour: 8, end_hour: 8 },
  ])("rejeita configuração inválida %j", (patch) => {
    expect(sendWindowSchema.safeParse({ ...window, ...patch }).success).toBe(false);
  });
  it("mantém o grafo legado sem inventar uma janela", () => {
    const old = { mode: "fixed", duration_ms: 300_000 };
    expect(waitConfigSchema.parse(old)).toEqual(old);
  });

  const node: FlowNode = {
    id: "wait",
    type: "wait",
    label: "Janela útil",
    position: { x: 0, y: 0 },
    config: { mode: "fixed", duration_ms: 300_000, send_window: window },
  };
  const enrollment = { current_node_id: "wait" } as EnrollmentRow;
  const lead: LeadFacts = { lead_stage: null, tags: [], steps_taken: 0, last_outcome: null };
  const edges = [
    {
      id: "next",
      source: "wait",
      target: "guard",
      priority: 0,
      condition: { type: "always" as const },
    },
  ];
  it("primeiro retorno não ganha outras duas horas após o gatilho de silêncio", () => {
    const r = processNode({
      node,
      enrollment,
      lead,
      edges,
      clock: () => new Date("2026-10-20T16:00:00-03:00"),
    });
    expect(r).toEqual({ kind: "wait", next_eval_at: new Date("2026-10-20T16:05:00-03:00") });
  });
  it.each([{ waitElapsed: true }, { wokeEarly: true }])(
    "revalida horário em reentrada %j",
    (phase) => {
      const r = processNode({
        node,
        enrollment,
        lead,
        edges,
        ...phase,
        clock: () => new Date("2026-10-23T21:00:00-03:00"),
      });
      expect(r).toEqual({ kind: "wait", next_eval_at: new Date("2026-10-26T08:00:00-03:00") });
    },
  );
  it("libera uma espera vencida dentro da janela sem somar a duração novamente", () => {
    expect(
      processNode({
        node,
        enrollment,
        lead,
        edges,
        waitElapsed: true,
        clock: () => new Date("2026-10-20T16:05:00-03:00"),
      }),
    ).toMatchObject({ kind: "advance", next_node_id: "guard" });
  });
});
