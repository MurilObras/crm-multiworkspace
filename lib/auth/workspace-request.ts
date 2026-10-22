import { fail } from '@/lib/api/wrappers';

/** O header só confere o workspace esperado. Nunca escolhe tenant nem concede acesso.
 * Evita guardar a resposta do workspace novo na chave de cache do anterior quando
 * outra aba troca o cookie enquanto uma requisição está começando. */
export function workspaceRequestGuard(req:Pick<Request,'headers'>|undefined,organizationId:string,requestId:string) {
  const expected=req?.headers?.get('X-Workspace-Id');
  return expected&&expected!==organizationId
    ?fail('state_conflict','O workspace mudou. Atualize a tela antes de continuar.',409,{requestId}):null;
}
