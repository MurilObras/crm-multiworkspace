/**
 * Ler de qual anúncio o contato veio — o outro lado da 0164.
 *
 * A 0164 (`lib/leads/atribuicao-de-anuncio.ts`) ESTAMPA a atribuição no contato,
 * com guarda de primeiro toque e merge atômico no banco. Este arquivo é o
 * primeiro consumidor dela: até aqui o dado era só de escrita.
 *
 * Não reaproveito o tipo `AtribuicaoDeAnuncio` daquele módulo de propósito. Ele
 * é o formato de ESCRITA e carrega `bruto` — o payload inteiro de onde o dado
 * saiu, que existe para ser prova e pode ter qualquer tamanho. Quem vai enviar
 * precisa de três campos, e arrastar o payload cru para dentro do caminho de
 * envio só criaria chance de ele vazar para um log ou para o fio.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehPlataformaConhecida } from "@/lib/plataformas-de-anuncio/registry";
import type { PlataformaDeAnuncio } from "@/lib/plataformas-de-anuncio/types";

export interface AtribuicaoParaEnvio {
  plataforma: PlataformaDeAnuncio;
  /** `ad_source_id` — o `ctwa_clid`, o clique que abriu a conversa. */
  cliqueDeOrigem: string;
  telefone: string | null;
}

export type LeituraDeAtribuicao =
  | { temAtribuicao: true; atribuicao: AtribuicaoParaEnvio }
  | { temAtribuicao: false; motivo: "sem_contato" | "sem_atribuicao" | "plataforma_desconhecida" | 'consulta_falhou' | 'contato_anonimizado' };

/**
 * ⚠️ FILTRA `organization_id` MESMO TENDO O ID DO CONTATO. O chamador é um
 * worker com client service-role, que bypassa RLS: um `contact_id` de outra
 * organização (por dado corrompido ou por bug de quem monta o evento) leria o
 * telefone e o clique de um terceiro e reportaria a venda na conta de anúncios
 * errada. O mesmo padrão de `encerraDemanda`, e pelo mesmo motivo.
 */
export async function lerAtribuicao(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string | null,
  leadId?:string,
): Promise<LeituraDeAtribuicao> {
  if (!contactId) return { temAtribuicao: false, motivo: "sem_contato" };

  const { data,error } = await admin
    .from("contacts")
    .select("phone_number, source_metadata, is_anonymized")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if(error)return {temAtribuicao:false,motivo:'consulta_falhou'};
  if (!data) return { temAtribuicao: false, motivo: "sem_contato" };
  if(data.is_anonymized)return {temAtribuicao:false,motivo:'contato_anonimizado'};

  const linha = data as { phone_number: string | null; source_metadata: unknown };
  const meta =
    linha.source_metadata && typeof linha.source_metadata === "object"
      ? (linha.source_metadata as Record<string, unknown>)
      : {};

  let plataforma=meta.ad_platform;
  const raw=meta.ad_raw&&typeof meta.ad_raw==='object'?meta.ad_raw as Record<string,unknown>:{};
  // O campo legado ad_source_id misturava anúncio e clique. Só um clique
  // comprovado pelo payload original pode alimentar a conversão da plataforma.
  let proof=meta.ad_click_id??raw.ctwa_clid??raw.ctwaClid;
  if(leadId) {
    const snapshot=await admin.from('crm_lead_attribution').select('source,click_id').eq('organization_id',organizationId)
      .eq('lead_id',leadId).maybeSingle();
    if(snapshot.error)return {temAtribuicao:false,motivo:'consulta_falhou'};
    if(snapshot.data){plataforma=snapshot.data.source;proof=snapshot.data.click_id;}
  }
  const clique=typeof proof==='string'?proof.trim():'';
  // Sem o clique não há atribuição utilizável: é ele que liga a venda ao anúncio.
  // Ter `ad_platform` sem `ad_source_id` acontece quando o payload trouxe o
  // referral sem o identificador — a 0164 grava os dois como vieram.
  if (!clique) return { temAtribuicao: false, motivo: "sem_atribuicao" };

  // Plataforma que não está no vocabulário significa dado gravado por uma versão
  // futura (ou corrompido). Recusar explicitamente é melhor que assumir a Meta e
  // reportar a venda na conta errada.
  if (!ehPlataformaConhecida(plataforma)) {
    return { temAtribuicao: false, motivo: "plataforma_desconhecida" };
  }

  return {
    temAtribuicao: true,
    atribuicao: {
      plataforma,
      cliqueDeOrigem: clique,
      // Só dígitos: a plataforma exige E.164 sem `+` nem separadores ANTES do
      // hash. Normalizar depois do hash seria tarde — o hash já estaria errado.
      telefone: linha.phone_number ? linha.phone_number.replace(/\D/g, "") || null : null,
    },
  };
}
