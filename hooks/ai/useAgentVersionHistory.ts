"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { AgentVersionRow } from "./useAgentVersions";

export function useAgentVersionHistory(agentId: string, active: boolean, revision: string) {
  return useInfiniteQuery({
    queryKey: ["agent-version-history", agentId, revision],
    enabled: active,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: "20" });
      if (pageParam !== undefined) params.set("before_version", String(pageParam));
      const response = await apiClient.get<{ data: AgentVersionRow[]; meta?: { has_more: boolean; cursor: string | null } }>(
        `/api/v1/ai/agents/${agentId}/versions?${params}`, { signal });
      return { versions: response.data, next: response.meta?.has_more ? response.meta.cursor : null };
    },
    getNextPageParam: page => page.next ?? undefined,
  });
}
