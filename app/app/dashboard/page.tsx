import { notFound } from 'next/navigation';
import { requireAuth,resolveActiveOrg } from '@/lib/auth/server';
import { roleAtLeast } from '@/lib/auth/types';
import { createClient } from '@/lib/supabase/server';
import { FUSO_PADRAO,fusoValido } from '@/lib/tempo/fusos';
import { dashboardDay } from '@/lib/dashboard/period';
import { DashboardClient } from './_components/DashboardClient';

export const dynamic='force-dynamic';
export const metadata={title:'Dashboard'};
export default async function DashboardPage() {
  const user=await requireAuth();
  const org=await resolveActiveOrg(user);
  if(!org || !roleAtLeast(org.role,'agent')) notFound();
  const db=await createClient();
  const {data}=await db.from('organizations').select('timezone').eq('id',org.orgId).single();
  const timezone=typeof data?.timezone==='string' && fusoValido(data.timezone)?data.timezone:FUSO_PADRAO;
  const today=dashboardDay(new Date().getTime(),timezone);
  return <DashboardClient key={org.orgId} organizationId={org.orgId} currentUserId={user.id}
    canManage={roleAtLeast(org.role,'manager')} initialFrom={`${today.slice(0,8)}01`} initialTo={today} />;
}
