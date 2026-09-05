"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { createWorkspace } from "@/app/actions/workspace/createWorkspace";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Cria um NOVO workspace (organização) a partir da sessão atual.
 *
 * Workspace é o nome de PRODUTO da entidade técnica `organizations` — este
 * diálogo não cria tabela nenhuma nem mexe em RLS. No sucesso, a server action
 * troca a organização ativa e redireciona para o onboarding do workspace novo.
 */
export function CreateWorkspaceDialog({ open, onOpenChange }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    startTransition(async () => {
      const r = await createWorkspace(name.trim());
      if (!r.ok) {
        if (r.error === "rate_limited") toast.error(t("Calma — muitas tentativas. Espere alguns segundos."));
        else toast.error(t("Não foi possível criar o workspace agora. Tente novamente."));
      }
      // No sucesso, `createWorkspace` redireciona — não há o que fazer aqui.
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("Criar workspace")}</DialogTitle>
          <DialogDescription>
            {t("Um espaço isolado para um novo time, com seus próprios números, funis e agentes.")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="workspace-name">{t("Nome do workspace")}</Label>
            <Input
              id="workspace-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("ex: Time Comercial, Loja Sul")}
              disabled={isPending}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={isPending} onClick={() => onOpenChange(false)}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={isPending || !name.trim()}>
              {isPending ? t("Criando...") : t("Criar workspace")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
