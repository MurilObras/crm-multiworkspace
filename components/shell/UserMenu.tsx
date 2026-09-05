"use client";
import { useState, useTransition } from "react";
import { useUser, useAuth } from "@/hooks/auth/AuthProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { SeletorDeIdioma } from "@/components/shell/SeletorDeIdioma";
import { CreateWorkspaceDialog } from "@/components/workspace/CreateWorkspaceDialog";
import { useT } from "@/hooks/i18n/useT";
import { Plus, SignOut } from "@/lib/ui/icons";

function initials(name: string | null, email: string): string {
  if (name && name.trim()) {
    return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

export function UserMenu() {
  const t = useT();
  const user = useUser();
  const { signOut } = useAuth();
  const [isPending, startTransition] = useTransition();
  const [criarAberto, setCriarAberto] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <SeletorDeIdioma />
      <ThemeToggle />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="rounded-full" aria-label={t("Menu do usuário")}>
            <Avatar className="h-8 w-8">
              {user.avatar_url && <AvatarImage src={user.avatar_url} alt="" />}
              <AvatarFallback>{initials(user.full_name, user.email)}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[220px]">
          <DropdownMenuLabel>
            <div className="flex flex-col">
              <span className="text-sm font-medium">{user.full_name ?? user.email}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="criar-workspace"
            onSelect={(e) => {
              e.preventDefault();
              setCriarAberto(true);
            }}
          >
            <Plus size={16} className="mr-2" aria-hidden />
            {t("Criar workspace")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={isPending} onClick={() => startTransition(async () => { await signOut(); })}>
            <SignOut size={16} className="mr-2" aria-hidden />
            {t("Sair")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={criarAberto} onOpenChange={setCriarAberto} />
    </div>
  );
}
