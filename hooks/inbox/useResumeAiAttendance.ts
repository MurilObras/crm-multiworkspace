"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

interface ResumeArgs {
  conversation_id: string;
}

/** O que a pessoa fez, devolvido junto com o controle — nunca só o controle. */
export interface ContinuidadeDaRetomada {
  houve_atendimento_humano: boolean;
  resumo: string;
  decisoes: number;
  notas: number;
}

interface ResumeResponse {
  data: { reactivated: boolean; pending_case_id?: string | null; continuidade: ContinuidadeDaRetomada };
}

/**
 * Devolve a conversa ao atendimento automático.
 *
 * A rota existia desde a IA-06 e NENHUMA tela a chamava — passagem para humano
 * sem caminho de volta na interface. Enquanto isso, ela também não devolvia de
 * verdade (ver `lib/escalacao/retomada.ts`). O botão e o conserto andam juntos
 * de propósito: um botão sobre a rota antiga seria uma porta para uma sala vazia.
 */
export function useResumeAiAttendance() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (args: ResumeArgs) =>
      apiClient.post<ResumeResponse>(
        `/api/v1/conversations/${args.conversation_id}/reactivate-bot`,
        {},
      ),
    onError: (err) => showApiError(err),
    onSuccess: (result, args) => {
      if (!result.data.reactivated && result.data.pending_case_id)
        toast.warning("Aguardando resolução da consulta. Responda no Inbox com a opção de resolver a consulta ou abra Casos.");
      qc.invalidateQueries({ queryKey: ["conversations"] });
      qc.invalidateQueries({ queryKey: ["conversation", args.conversation_id] });
    },
  });
}
