/** Validador da política estrita: percorre o JSON REAL serializado pelo SDK.
 * Não simula aceitação pelo serviço remoto (essa prova é um smoke separado). */
export function assertStrictOutputSchema(value: unknown): void {
  function visit(node: unknown): void {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const s = node as Record<string, unknown>;
    if (s.type === 'object' || s.properties) {
      if (s.additionalProperties !== false) throw new Error('objeto aberto');
      const properties = Object.keys(s.properties as object).sort();
      const required = Array.isArray(s.required) ? [...s.required].sort() : [];
      if (JSON.stringify(properties) !== JSON.stringify(required)) throw new Error('propriedades opcionais');
      Object.values(s.properties as object).forEach(visit);
    }
    if (s.items) visit(s.items);
    for (const key of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(s[key])) s[key].forEach(visit);
    if (s.$defs) Object.values(s.$defs as object).forEach(visit);
  }
  const root = value as Record<string, unknown>;
  if (!root || root.type !== 'object' || root.anyOf) throw new Error('raiz precisa ser objeto');
  visit(root);
}
