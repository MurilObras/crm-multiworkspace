// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { guardCurrentInboundTools } from "@/lib/agent-engine/agent/current-inbound-tools";

describe("ferramentas de uma mesma inbound", () => {
  it("espera efeito em andamento e bloqueia tools nativas/MCP posteriores à mensagem nova", async () => {
    let current = true;
    let release!: () => void;
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const mutate = vi.fn(async () => {
      started();
      await inFlight;
    });
    const mcp = vi.fn(async () => {});
    const native = vi.fn(async () => {});
    const wrapped = guardCurrentInboundTools(
      {
        first: tool({ inputSchema: z.object({}), execute: mutate }),
        crm_any_mutation: tool({ inputSchema: z.object({}), execute: mcp }),
        save_lead_note: tool({ inputSchema: z.object({}), execute: native }),
      },
      async () => {
        if (!current) throw new Error("superseded");
      },
    );
    const opts = { toolCallId: "test", messages: [], context: {} };
    const first = wrapped.tools.first!.execute!({}, opts);
    await didStart;
    const second = Promise.resolve(wrapped.tools.crm_any_mutation!.execute!({}, opts));
    const third = Promise.resolve(wrapped.tools.save_lead_note!.execute!({}, opts));
    const results = Promise.allSettled([first, second, third]);
    let drained = false;
    const drain = wrapped.drain().then(() => {
      drained = true;
    });
    current = false;
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(mcp).not.toHaveBeenCalled();
    release();
    expect((await results).map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "rejected",
    ]);
    await drain;
    expect(drained).toBe(true);
    expect(native).not.toHaveBeenCalled();
    expect(mcp).not.toHaveBeenCalled();
  });

  it("libera a espera após erro sem bloquear outra ferramenta ainda válida", async () => {
    const second = vi.fn(async () => "ok");
    const wrapped = guardCurrentInboundTools(
      {
        first: tool({
          inputSchema: z.object({}),
          execute: async (): Promise<string> => {
            throw new Error("failure");
          },
        }),
        second: tool({ inputSchema: z.object({}), execute: second }),
      },
      async () => {},
    );
    const opts = { toolCallId: "test", messages: [], context: {} };
    await expect(wrapped.tools.first!.execute!({}, opts)).rejects.toThrow("failure");
    await expect(wrapped.tools.second!.execute!({}, opts)).resolves.toBe("ok");
    await wrapped.drain();
    expect(second).toHaveBeenCalledOnce();
  });
});
