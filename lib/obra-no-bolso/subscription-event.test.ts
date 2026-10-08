import { describe, it, expect } from "vitest";
import { classifySubscription, nextObraProactiveWindow, validateSubscriptionEvent,
  type SubscriptionEvent } from "./subscription-event";

const event: SubscriptionEvent = { version: 2, event_type: "subscription_status_checked",
  event_id: "4d8f203c-9528-4e6f-a781-746b991da951", product_user_id: "820d31a5-1b20-48f4-babc-9f7039034765",
  occurred_at: "2026-10-12T12:00:00Z", checked_at: "2026-10-12T12:00:00Z",
  trial_started_at: "2026-10-08T12:00:00Z", name: "Teste", email: "test@example.invalid",
  phone: "5562999990000", status_pagamento: "ativo", em_trial: false,
  trial_ends_at: null, access_expires_at: "2026-11-12T12:00:00Z", access_enabled: true };

describe("estado do aplicativo", () => {
  it("não transforma ativo durante trial em venda paga", () => {
    expect(classifySubscription({ ...event, em_trial: true })).toBe("manual");
    expect(classifySubscription({ ...event, event_type: "trial_started" })).toBe("trial");
  });
  it("96 horas completas incluem fim de semana", () => {
    expect(validateSubscriptionEvent(event, Date.parse(event.occurred_at)).ok).toBe(true);
    expect(validateSubscriptionEvent({ ...event, checked_at: "2026-10-12T11:59:59Z" }, Date.parse(event.occurred_at)).ok).toBe(false);
    expect(classifySubscription(event)).toBe("paid");
  });
  it.each(["suspenso", "cancelado"])("identifica %s sem inventar motivo", status_pagamento => {
    expect(classifySubscription({ ...event, status_pagamento, access_enabled: false, em_trial: true })).toBe("recover");
    expect(classifySubscription({ ...event, status_pagamento })).toBe("manual");
  });
  it("dados contraditórios, grátis ou vencidos exigem humano", () => {
    expect(classifySubscription({ ...event, status_pagamento: "gratis" })).toBe("manual");
    expect(classifySubscription({ ...event, access_enabled: false })).toBe("manual");
    expect(classifySubscription({ ...event, trial_ends_at: "2026-10-14T12:00:00Z" })).toBe("manual");
    expect(classifySubscription({ ...event, access_expires_at: event.checked_at })).toBe("manual");
  });
  it("não aceita campos de workspace no corpo nem consulta anterior ao trial", () => {
    expect(validateSubscriptionEvent({ ...event, organization_id: "other" }).ok).toBe(false);
    expect(validateSubscriptionEvent({ ...event, trial_started_at: "2026-10-13T12:00:00Z" }).ok).toBe(false);
  });
});

describe("janela exclusiva de proativos", () => {
  it.each([
    ["2026-10-09T22:59:59Z", null], // sexta 19:59
    ["2026-10-09T23:00:00Z", "2026-10-12T11:00:00.000Z"],
    ["2026-10-10T15:00:00Z", "2026-10-12T11:00:00.000Z"],
    ["2026-10-11T15:00:00Z", "2026-10-12T11:00:00.000Z"],
    ["2026-10-12T10:59:59Z", "2026-10-12T11:00:00.000Z"],
    ["2026-10-12T11:00:00Z", null],
  ])("%s", (at, expected) => expect(nextObraProactiveWindow(new Date(at))?.toISOString() ?? null).toBe(expected));
});
