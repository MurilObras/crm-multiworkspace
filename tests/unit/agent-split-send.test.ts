import { describe, expect, it, vi } from "vitest";

import { sendInBubbles } from "@/lib/agent-engine/agent/split-message";

describe("sendInBubbles", () => {
  it.each([1, 2, 3])('cabe no espaço físico restante (%s), sem perder conteúdo', async maxBubbles => {
    const parts = ['Primeira parte.', 'Segunda parte.', 'Terceira parte.'];
    const body = parts.join('\n\n');
    const send = vi.fn(async (_body: string) => ({ kind: 'sent', messageId: 'm' }));
    await sendInBubbles(body, { enabled: true, maxChars: 18, maxBubbles,
      send, sleep: async () => {}, jitter: () => 0 });
    expect(send).toHaveBeenCalledTimes(maxBubbles);
    expect(send.mock.calls.map(([text]) => text).join('\n\n')).toBe(body);
  });
  it("split off → 1 envio com o corpo inteiro", async () => {
    const send = vi.fn(async () => ({ kind: "sent", messageId: "m" }));
    const sleep = vi.fn(async () => undefined);
    const out = await sendInBubbles("um texto qualquer", { enabled: false, maxChars: 600, send, sleep, jitter: () => 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("um texto qualquer");
    expect(out.kind).toBe("sent");
  });

  it("split on + texto longo → N envios com jitter entre eles", async () => {
    const send = vi.fn(async () => ({ kind: "sent", messageId: "m" }));
    const sleep = vi.fn(async () => undefined);
    const text = "Primeira ideia aqui.\n\nSegunda ideia aqui.\n\nTerceira ideia aqui.";
    const out = await sendInBubbles(text, { enabled: true, maxChars: 25, send, sleep, jitter: () => 900 });
    expect(send.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(sleep).toHaveBeenCalledWith(900); // jitter entre bolhas
    expect(out.kind).toBe("sent");
  });

  it("para no primeiro envio não-sent (veto/falha) e devolve esse outcome", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ kind: "sent", messageId: "m1" })
      .mockResolvedValueOnce({ kind: "blocked" });
    const sleep = vi.fn(async () => undefined);
    const text = "Bolha um aqui.\n\nBolha dois aqui.\n\nBolha três aqui.";
    const out = await sendInBubbles(text, { enabled: true, maxChars: 20, send, sleep, jitter: () => 0 });
    expect(out.kind).toBe("blocked");
    expect(send).toHaveBeenCalledTimes(2); // parou na 2ª
  });

  it("não ultrapassa uma parte queued mesmo que o canal volte antes da próxima", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ kind: "queued", messageId: "pendente" })
      .mockResolvedValueOnce({ kind: "sent", messageId: "fora-de-ordem" });
    const prepare = vi.fn(async (_parts: string[]) => undefined);
    const sleep = vi.fn(async () => undefined);
    const text = "Primeira parte.\n\nSegunda parte.";
    const out = await sendInBubbles(text, { enabled: true, maxChars: 16, prepare,
      send, sleep, jitter: () => 0 });
    expect(prepare).toHaveBeenCalledWith(["Primeira parte.", "Segunda parte."]);
    expect(out.kind).toBe("queued");
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

it('não reagrupa partes já aprovadas quando o limite muda na retomada',async()=>{
 const sent:string[]=[];
 await expect(sendInBubbles('Primeira. Segunda.',{enabled:true,maxChars:5,maxBubbles:1,plannedBubbles:['Primeira.','Segunda.'],send:async body=>{sent.push(body);return {kind:'sent'};},sleep:async()=>{},jitter:()=>0})).rejects.toThrow('response_send_limit_changed');
 expect(sent).toEqual([]);
});
it('persiste o plano inteiro antes do primeiro transporte e conserva a ordem original',async()=>{
 const events:string[]=[];
 await sendInBubbles('Texto original',{enabled:false,maxChars:100,plannedBubbles:['A','B'],prepare:async parts=>{events.push('prepare:'+parts.join(','));},send:async body=>{events.push(body);return {kind:'sent'};},sleep:async()=>{},jitter:()=>0});
 expect(events).toEqual(['prepare:A,B','A','B']);
});
