import { expect, it } from "vitest";
import {
  mediaRunDiagnostic,
  type MediaRunJob,
  type MediaRunMessage,
} from "@/lib/ai/agents/media-run-diagnostic";

const org = "10000000-0000-4000-8000-000000000001",
  agent = "10000000-0000-4000-8000-000000000002";
const conversation = "10000000-0000-4000-8000-000000000003",
  inbound = "10000000-0000-4000-8000-000000000004";
const media = "10000000-0000-4000-8000-000000000005";
const decision = {
  version: 1,
  organization_id: org,
  agent_id: agent,
  conversation_id: conversation,
  inbound_message_id: inbound,
  subject_sha256: "a".repeat(64),
  approval_sha256: "b".repeat(64),
  policy: "explicit_repeat",
  audio_id: media,
  authorized_id: media,
  intent: "show",
  format: "video",
  text_only: false,
  selected_title: "Demonstração",
  reason: "authorized",
};
const job: MediaRunJob = {
  id: inbound,
  organization_id: org,
  contact_id: media,
  payload: {
    conversation_id: conversation,
    inbound_message_id: inbound,
    media_intent_decision: decision,
  },
};
const message: MediaRunMessage = {
  id: agent,
  organization_id: org,
  conversation_id: conversation,
  status: "failed",
  external_id: null,
  error_code: "outbound_delivery_uncertain",
  metadata: {
    approved_media: { agent_id: agent, media_id: media },
    outbound_attempt: { phase: "uncertain" },
  },
};
it("histórico sem decisão não recebe reconstrução inventada", () => {
  expect(mediaRunDiagnostic(org, agent, media, { ...job, payload: {} }, [])).toBeNull();
});
it("decisão autorizada, tentativa incerta e entrega confirmada são estados separados", () => {
  expect(mediaRunDiagnostic(org, agent, media, job, [])?.media_decision.transport).toBe(
    "not_attempted",
  );
  expect(mediaRunDiagnostic(org, agent, media, job, [message])?.media_decision).toMatchObject({
    authorized: true,
    transport: "uncertain",
    reason: "outbound_delivery_uncertain",
  });
  expect(
    mediaRunDiagnostic(org, agent, media, job, [
      { ...message, status: "read", external_id: "provider-id", error_code: null },
    ])?.media_decision.transport,
  ).toBe("confirmed");
});
it("não associa outro workspace, conversa, cliente ou agente por proximidade temporal", () => {
  expect(mediaRunDiagnostic(agent, agent, media, job, [message])).toBeNull();
  expect(mediaRunDiagnostic(org, org, media, job, [message])).toBeNull();
  expect(mediaRunDiagnostic(org, agent, org, job, [message])).toBeNull();
  expect(
    mediaRunDiagnostic(org, agent, media, job, [
      { ...message, conversation_id: agent, status: "read", external_id: "wrong" },
    ])?.media_decision.transport,
  ).toBe("not_attempted");
});
