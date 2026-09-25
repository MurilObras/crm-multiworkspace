"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";

export interface KiwifyIntegrationRow {
  id: string;
  name: string;
  store_id: string;
  path_token: string;
  pipeline_id: string;
  stage_id: string;
  is_active: boolean;
}

export interface KiwifyProductMapping {
  integration_id: string;
  external_product_id: string;
  product_id: string;
}

export interface KiwifyIntegrationState {
  integrations: KiwifyIntegrationRow[];
  products: KiwifyProductMapping[];
  links?: Array<{ integration_id: string; rule_id: string }>;
}

export interface KiwifyProductMappingInput {
  external_product_id: string;
  product_id: string;
}

export interface CreateKiwifyIntegrationInput {
  name: string;
  store_id: string;
  secret: string;
  pipeline_id: string;
  stage_id: string;
  products: KiwifyProductMappingInput[];
}

const KIWIFY_KEY = ["kiwify-integration"];
export type KiwifyOptions = {
  agents: Array<{ id: string; name: string; pipeline_ids: string[]; scheduling_reason: string | null }>;
  followups: Array<{ id: string; name: string }>;
};
export function useKiwifyOptions() {
  return useQuery({ queryKey: ["kiwify-options"], queryFn: () => apiClient.get<{ data: KiwifyOptions }>("/api/v1/integrations/kiwify/options"), staleTime: 15_000 });
}

export function useKiwifyIntegration() {
  return useQuery({
    queryKey: KIWIFY_KEY,
    queryFn: async () => apiClient.get<{ data: KiwifyIntegrationState }>("/api/v1/integrations/kiwify"),
    staleTime: 15_000,
  });
}

export function useCreateKiwifyIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateKiwifyIntegrationInput) =>
      apiClient.post<{ data: { integration_id: string; endpoint: string } }>(
        "/api/v1/integrations/kiwify",
        input,
      ),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: KIWIFY_KEY }),
  });
}

export function useManageKiwifyIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; operation: "edit" | "archive" | "link" | "unlink"; config?: Omit<CreateKiwifyIntegrationInput, "secret"> & { secret?: string }; ruleId?: string }) => {
      const path = `/api/v1/integrations/kiwify/${input.id}`;
      if (input.operation === "edit") return apiClient.patch(path, input.config);
      if (input.operation === "archive") return apiClient.delete(path);
      const body = { rule_id: input.ruleId };
      return input.operation === "link" ? apiClient.put(`${path}/automations`, body) : apiClient.delete(`${path}/automations`, body);
    },
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: KIWIFY_KEY }),
  });
}
