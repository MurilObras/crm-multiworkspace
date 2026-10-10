import type { ToolSet } from "ai";

/** O SDK pode executar várias tools do mesmo step em paralelo. A fila local
 * conserva a ordem e revalida ANTES de cada efeito, inclusive tools MCP.
 * drain precisa terminar antes de liberar a lane do contato no Postgres. */
export function guardCurrentInboundTools(tools: ToolSet, assertCurrent: () => Promise<void>) {
  let tail: Promise<void> = Promise.resolve();
  const guarded: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    const execute = definition.execute;
    if (!execute) {
      guarded[name] = definition;
      continue;
    }
    guarded[name] = {
      ...definition,
      execute: (async (...args: Parameters<typeof execute>) => {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        try {
          await assertCurrent();
          return await execute(...args);
        } finally {
          release();
        }
      }) as typeof execute,
    };
  }
  return { tools: guarded, drain: () => tail };
}
