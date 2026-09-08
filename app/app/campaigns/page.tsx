import { redirect } from "next/navigation";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { CampaignsClient } from "./client";

export const dynamic = "force-dynamic";
export default async function CampaignsPage() {
  const user = await requireAuth();
  const org = await resolveActiveOrg(user);
  if (!org) redirect("/app");
  return <CampaignsClient key={org.orgId} canSend={user.is_platform_admin || ROLE_RANK[org.role] >= ROLE_RANK.agent} />;
}
