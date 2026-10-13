/** Mesma ordem no histórico, fila e Inbox. UUID só desempata tempos idênticos. */
export const MESSAGE_ORDER_DESC = "coalesce(sent_at, created_at) desc, created_at desc, id desc";

type OrderedMessage = { id: string; sent_at?: string | null; created_at?: string };

// Date perde os microssegundos do Postgres. Preserve a fração no desempate.
function compareTimestamp(a: string, b: string): number {
  const millis = Date.parse(a) - Date.parse(b);
  if (millis) return millis;
  const fraction = (s: string) => (s.match(/\.(\d+)/)?.[1] ?? "").padEnd(9, "0").slice(3, 9);
  return fraction(a).localeCompare(fraction(b));
}

export function compareMessages(a: OrderedMessage, b: OrderedMessage): number {
  const at = a.sent_at ?? a.created_at ?? "";
  const bt = b.sent_at ?? b.created_at ?? "";
  return (
    compareTimestamp(at, bt) ||
    compareTimestamp(a.created_at ?? at, b.created_at ?? bt) ||
    a.id.localeCompare(b.id)
  );
}
