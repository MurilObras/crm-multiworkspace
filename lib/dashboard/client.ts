export class DashboardRequestError extends Error {constructor(message:string,readonly status:number){super(message);}}
export async function dashboardFetch<T>(url:string,options:RequestInit|undefined,organizationId:string):Promise<T> {
  if(!organizationId)throw new Error('Workspace não definido. Atualize a tela.');
  const headers=new Headers(options?.headers);
  headers.set('X-Workspace-Id',organizationId);
  const response=await fetch(url,{...options,headers});
  const body=await response.json();
  if(!response.ok) throw new DashboardRequestError(body.error?.message??'Não foi possível completar a operação.',response.status);
  return body.data as T;
}
export function dashboardMoney(cents:number|null,currency:string) {
  if(cents===null || !/^[A-Z]{3}$/.test(currency)) return '—';
  try{return new Intl.NumberFormat('pt-BR',{style:'currency',currency}).format(cents/100);}catch{return '—';}
}
