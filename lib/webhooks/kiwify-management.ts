import { fail } from "@/lib/api/wrappers";

/** Só códigos conhecidos atravessam a borda; erros SQL podem conter dados. */
export function kiwifyManagementError(error: { code?: string; message?: string }, requestId: string) {
  if (error.code === "23505") return fail("conflict", "Store ID duplicado: já existe uma integração operacional para esta loja.", 409, { requestId });
  const errors: Record<string, string> = {
    invalid_product: "Produto inválido ou inativo nesta organização.",
    invalid_pipeline: "Funil inválido nesta organização.",
    invalid_stage: "Etapa inválida para o funil selecionado.",
    duplicate_mapping: "O produto Kiwify está mapeado mais de uma vez.",
    integration_archived: "Esta integração está arquivada.",
    incompatible_automation: "Automação incompatível: selecione uma regra de compra aprovada Kiwify.",
    automation_not_found: "Automação não encontrada nesta organização.",
  };
  if (error.message === "integration_not_found") return fail("not_found", "Integração não encontrada.", 404, { requestId });
  return fail("invalid_request", errors[error.message ?? ""] ?? "Não foi possível salvar a configuração da integração.", 422, { requestId });
}
