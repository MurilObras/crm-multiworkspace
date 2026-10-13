import { describe, expect, it } from "vitest";
import { compareMessages } from "./message-order";
import { mergeThreadItems } from "@/components/inbox/ChatThread";
import type { Message, Note } from "@/lib/types/messaging";

const sent_at = "2026-10-13T14:16:00Z";
const first = {
  id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  sent_at,
  created_at: "2026-10-13T14:16:00.123001Z",
};
const correction = {
  id: "11111111-1111-4111-8111-111111111111",
  sent_at,
  created_at: "2026-10-13T14:16:00.123002Z",
};

describe("ordem de mensagens com horário igual", () => {
  it("correção posterior vem depois, mesmo com UUID menor e dentro do mesmo milissegundo", () => {
    expect([correction, first].sort(compareMessages)).toEqual([first, correction]);
  });
  it("thread de páginas carregadas em ordem inversa preserva o desempate do banco", () => {
    const input = [correction, first] as Message[];
    expect(mergeThreadItems(input, []).map((item) => item.data.id)).toEqual([
      first.id,
      correction.id,
    ]);
    expect(input[0]).toBe(correction);
  });
  it("horário do provedor precede chegada atrasada do webhook", () => {
    const delayed = {
      ...first,
      sent_at: "2026-10-13T14:15:59Z",
      created_at: "2026-10-13T14:20:00Z",
    };
    expect([correction, delayed].sort(compareMessages)).toEqual([delayed, correction]);
  });
  it("offsets diferentes do mesmo instante usam o mesmo desempate", () => {
    expect(
      compareMessages({ ...first, sent_at: "2026-10-13T11:16:00-03:00" }, correction),
    ).toBeLessThan(0);
  });
  it("UUID só decide quando ambos os tempos empatam", () => {
    expect(
      compareMessages({ ...first, created_at: correction.created_at }, correction),
    ).toBeGreaterThan(0);
  });
  it("notas com o mesmo instante não tornam a ordenação dependente da entrada", () => {
    const note = { id: "note", created_at: sent_at } as Note;
    for (const messages of [
      [correction, first],
      [first, correction],
    ]) {
      expect(mergeThreadItems(messages as Message[], [note]).map((i) => i.data.id)).toEqual([
        note.id,
        first.id,
        correction.id,
      ]);
    }
  });
});
