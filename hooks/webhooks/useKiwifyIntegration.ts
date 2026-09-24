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
