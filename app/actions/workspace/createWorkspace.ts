"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAuth } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { slugify } from "@/lib/auth/provision";
import { organizationNameSchema } from "@/lib/auth/schemas";
import { authRateLimited, AUTH_LIMITS } from "@/lib/auth/rate-limit";
import { audit } from "@/lib/audit";
import { cookieSecure } from "@/lib/supabase/cookie-secure";

export type CreateWorkspaceResult =
  | { ok: true }
  | { ok: false; error: "validation_error" | "rate_limited" | "provision_failed" };

const ACTIVE_ORG_COOKIE = "active_org";

/**
 * Cria um NOVO workspace (organização) para o usuário logado — ao contrário de
 * `recoverOrganization`, que só roda para quem NÃO tem organização nenhuma.
 *
 * Workspace é o nome de PRODUTO da entidade técnica `organizations`: esta action
 * não cria nenhuma tabela nova e não mexe em RLS. Ela apenas escreve uma linha
 * em `organizations` + a membership `admin` em `user_organizations`, pelo mesmo
 * caminho service-role do signup (`ensureTenantForUser`), já que o usuário ainda
 * não pertence à org que está criando.
 *
 * Só o NOME vem do cliente, e passa por Zod. `organization_id` e papel nunca são
 * aceitos de fora: a membership nasce `admin` sempre.
 */
export async function createWorkspace(name: string): Promise<CreateWorkspaceResult> {
  const parsed = organizationNameSchema.safeParse(name);
  if (!parsed.success) return { ok: false, error: "validation_error" };

  const user = await requireAuth();

  if (await authRateLimited("workspace_create", user.id, AUTH_LIMITS.workspace_create)) {
    return { ok: false, error: "rate_limited" };
  }

  const admin = createAdminClient();
  const base = slugify(parsed.data);

  let org: { id: string; slug: string } | null = null;
  for (let attempt = 0; attempt < 3 && !org; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const { data, error } = await admin
      .from("organizations")
      .insert({
        slug,
        display_name: parsed.data,
        legal_name: parsed.data,
        status: "active",
        created_by: user.id,
      })
      .select("id, slug")
      .single();
    if (data) {
      org = data;
    } else if (error && error.code !== "23505") {
      throw new Error(`createWorkspace: org insert failed: ${error.message}`);
    }
  }
  if (!org) throw new Error("createWorkspace: slug exhausted after 3 attempts");

  // A membership é o vínculo que dá dono à organização. Se ela falhar DEPOIS de a
  // organização existir, a linha nova fica órfã — sem nenhum membro para enxergá-la
  // (o RLS de `user_organizations` só deixa inserir se já houver um admin, então
  // ninguém conseguiria se associar depois). Não existe RPC atômico org+membership
  // na base, e criar um só para isto seria migration + RLS sem necessidade; o
  // padrão disponível é a COMPENSAÇÃO: falhou a membership, apaga a organização
  // recém-criada e devolve erro, em vez de deixar lixo invisível no banco.
  const { error: memberError } = await admin.from("user_organizations").insert({
    user_id: user.id,
    organization_id: org.id,
    role: "admin",
    accepted_at: new Date().toISOString(),
  });
  if (memberError && memberError.code !== "23505") {
    const { error: rollbackError } = await admin
      .from("organizations")
      .delete()
      .eq("id", org.id);
    if (rollbackError) {
      throw new Error(
        `createWorkspace: membership insert failed (${memberError.message}) and ` +
          `orphan rollback failed (${rollbackError.message}) — org ${org.id} pode ter ficado órfã`,
      );
    }
    throw new Error(`createWorkspace: membership insert failed: ${memberError.message}`);
  }

  void audit({
    action: "tenant.created_by_user",
    actorUserId: user.id,
    organizationId: org.id,
    resourceType: "organization",
    resourceId: org.id,
    bypassedRls: true,
    metadata: { slug: org.slug },
  });

  // A org nova vira a ATIVA: quem criou acaba de decidir onde quer trabalhar.
  const store = await cookies();
  store.set(ACTIVE_ORG_COOKIE, org.id, {
    httpOnly: true,
    sameSite: "strict",
    secure: cookieSecure(),
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  revalidatePath("/app", "layout");
  redirect("/onboarding/welcome");
}
