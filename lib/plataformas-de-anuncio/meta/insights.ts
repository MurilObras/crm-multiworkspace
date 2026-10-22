/**
 * A LEITURA de métricas da plataforma de anúncios da Meta.
 *
 * Irmão de `conversions.ts`: os dois são os únicos arquivos do repo, fora de
 * `lib/channels/`, que podem escrever o nome do endpoint — e é por isso que
 * existem separados. Tudo que sabe o formato do fio mora aqui, e some daqui para
 * dentro se a plataforma mudar. Este arquivo NÃO cruza dados nem calcula
 * derivadas: isso é `tabela-de-campanhas.ts`, que é puro e testável sem rede.
 *
 * ─── O que foi VERIFICADO contra a API viva, e não suposto ──────────────────
 *
 * Sondagem de 2026-09-02 contra a v22.0, numa conta real. Cinco achados que
 * mudam o código e que nenhuma leitura de documentação teria entregado:
 *
 * 1. `results` e `cost_per_result` EXISTEM e são o caminho certo para a coluna
 *    "Resultado". Cada um traz um `indicator` dizendo QUAL ação a plataforma
 *    contou (`actions:onsite_conversion.messaging_conversation_started_7d`,
 *    `actions:offsite_conversion.fb_pixel_lead`). Isto substitui derivar o
 *    action_type do `objective` da campanha — que erraria em campanha com ad
 *    sets de objetivos diferentes, porque a plataforma resolve por ad set.
 *
 * 2. `video_3_sec_watched_actions` FOI REMOVIDO. Pedi-lo devolve erro 100
 *    ("is not valid for fields param"), e o erro derruba a resposta INTEIRA —
 *    não é um campo omitido, é a chamada perdida. Era o numerador clássico do
 *    Hook Rate.
 *
 * 3. `video_continuous_2_sec_watched_actions` é aceito e volta VAZIO mesmo em
 *    campanha com vídeo. Não serve de substituto: pedi-lo custa e não entrega.
 *
 * 4. Campos de vídeo em campanha SEM vídeo são simplesmente OMITIDOS da linha —
 *    não dão erro. Por isso pedimos todos sempre, numa chamada só, em vez de
 *    descobrir antes quais campanhas têm criativo em vídeo (o que exigiria
 *    varrer `/ads` + creatives de cada campanha: N+1 para o mesmo resultado).
 *
 * 5. Campanha sem veiculação no período volta SEM `cpm`, SEM `ctr`, SEM `cpc`, e
 *    com `results: [{ indicator: "…" }]` — indicador presente e `values`
 *    AUSENTE. Quatro das sete campanhas da conta sondada estavam assim. Um
 *    `results[0].values[0].value` estoura na maioria das linhas reais.
 *
 * ─── Cota ───────────────────────────────────────────────────────────────────
 *
 * A conta sondada respondeu `ads_api_access_tier: "development_access"`, que tem
 * cota baixa. Cada abertura da tela gasta 2 chamadas (campanhas + insights), e o
 * botão "Atualizar" gasta 2 de novo. Por isso o 613/17 é classificado como
 * `limite_de_chamadas` e ganha mensagem própria na tela, em vez de virar "erro
 * ao carregar" — o operador precisa saber que a espera resolve.
 */
import { logger } from "@/lib/logger";
import type {
  ContaDeAnuncio,
  FalhaDeLeitura,
  ResultadoDeLeitura,
} from "../types";

/**
 * A MESMA versão que `conversions.ts` fixa, e pelo mesmo motivo: a instalação
 * não deve conviver com duas versões da mesma plataforma. Subir de versão é uma
 * mudança deliberada, feita nos dois arquivos, depois de reconferir os campos —
 * a lição do achado 2 acima é justamente que campo válido some entre versões.
 */
const VERSAO_DA_API = "v22.0";

const TEMPO_LIMITE_MS = 20_000;

/**
 * Teto de páginas por leitura.
 *
 * `paging.next` vem da plataforma, e seguir um cursor alheio sem teto é um laço
 * infinito esperando um bug do outro lado. 20 páginas × 500 campanhas cobre
 * qualquer conta que caiba nesta tela; acima disso o problema é a tela, não o
 * limite.
 */
const MAXIMO_DE_PAGINAS = 20;

/**
 * Os campos de insight, no nível de campanha.
 *
 * `video_3_sec_watched_actions` NÃO está aqui, e não é esquecimento — ver o
 * achado 2 no cabeçalho. Acrescentá-lo de volta derruba a tela inteira.
 */
const CAMPOS_DE_INSIGHTS = [
  "campaign_id",
  "campaign_name",
  "spend",
  "impressions",
  "reach",
  "cpm",
  "ctr",
  "frequency",
  "cpc",
  "results",
  "cost_per_result",
  "video_play_actions",
  "video_thruplay_watched_actions",
].join(",");

const CAMPOS_DE_CAMPANHA = ["id", "name", "status", "effective_status", "objective"].join(",");

// ─────────────────────────────────────────────────────────────────────────────
// O formato do fio — tipos do que a plataforma devolve
// ─────────────────────────────────────────────────────────────────────────────

/** Métrica que vem como lista rotulada (`results`, `cost_per_result`). */
export interface MetricaIndicada {
  indicator?: string;
  /** AUSENTE quando a campanha não veiculou. Ver achado 5. */
  values?: { value?: string }[];
}

/** Métrica que vem como lista por action_type (`video_play_actions`). */
export interface AcaoDeVideo {
  action_type?: string;
  value?: string;
}

export interface LinhaDeInsightCrua {
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  cpm?: string;
  ctr?: string;
  frequency?: string;
  cpc?: string;
  results?: MetricaIndicada[];
  cost_per_result?: MetricaIndicada[];
  video_play_actions?: AcaoDeVideo[];
  video_thruplay_watched_actions?: AcaoDeVideo[];
}

export interface CampanhaCrua {
  id?: string;
  name?: string;
  status?: string;
  effective_status?: string;
  objective?: string;
}

interface RespostaPaginada<T> {
  data?: T[];
  paging?: { next?: string };
}

interface ErroGraph {
  error?: {
    code?: number;
    error_subcode?: number;
    message?: string;
    type?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Classificação de erro
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Códigos de token. 190 é o genérico ("Invalid OAuth access token"); 102 é
 * sessão inválida; 463 é token expirado; 467 é token revogado. Todos pedem a
 * mesma coisa de quem opera: colar um token novo.
 */
const CODIGOS_DE_TOKEN = new Set([102, 190, 463, 467]);

/**
 * Códigos de permissão. 10 e 200 são "permissão negada"; 272 é conta fora do
 * alcance do token; 294 é falta de permissão de gestão. Token novo NÃO resolve
 * se ele for gerado com o mesmo escopo — a tela precisa citar `ads_read`.
 */
const CODIGOS_DE_PERMISSAO = new Set([10, 200, 272, 294]);

/**
 * Cota. 4 e 17 são limite de app/usuário, 32 é limite de página, 613 é
 * `Calls to this api have exceeded the rate limit`, e a família 80000-80004 é o
 * limite por caso de uso de negócio (o que o header
 * `x-business-use-case-usage` reporta).
 */
const CODIGOS_DE_COTA = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004]);

export function classificarErroGraph(
  status: number,
  codigo: number | null,
): FalhaDeLeitura {
  if (codigo !== null) {
    if (CODIGOS_DE_TOKEN.has(codigo)) return "token_invalido";
    if (CODIGOS_DE_PERMISSAO.has(codigo)) return "permissao_insuficiente";
    if (CODIGOS_DE_COTA.has(codigo)) return "limite_de_chamadas";
    // 100 = campo/parâmetro inválido. NÃO é problema de quem opera: ou é bug
    // nosso, ou a plataforma removeu o campo da versão que pedimos — exatamente
    // o que aconteceu com `video_3_sec_watched_actions` entre a v21 e a v22.
    // Mandar o operador "tentar mais tarde" desperdiça o dia dele: o conserto é
    // um deploy.
    if (codigo === 100) return "campo_invalido";
  }
  // 5xx sem código conhecido é instabilidade do outro lado.
  if (status >= 500) return "transitorio";
  // 4xx que não casou com nada acima: tratado como token, que é a causa mais
  // provável e a única com ação clara para quem lê a tela.
  return status === 401 || status === 403 ? "token_invalido" : "transitorio";
}

// ─────────────────────────────────────────────────────────────────────────────
// O transporte
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET numa URL da Graph, seguindo `paging.next` até o fim.
 *
 * O token vai no HEADER, nunca na query string — mesma regra de `conversions.ts`
 * e do CLAUDE.md (anti-pattern 12): token em URL vaza para log de proxy e para o
 * breadcrumb do Sentry. `paging.next` VOLTA com o token embutido na query,
 * porque a plataforma o monta assim; por isso ele é reescrito antes de ser
 * seguido, e nunca registrado em log.
 */
async function buscarPaginado<T>(
  urlInicial: string,
  token: string,
  contexto: string,
): Promise<ResultadoDeLeitura<T[]>> {
  const acumulado: T[] = [];
  let url: string | null = urlInicial;
  let pagina = 0;
  const deadline = Date.now() + 40_000;

  while (url && pagina < MAXIMO_DE_PAGINAS) {
    pagina += 1;
    if (Date.now() >= deadline) return {ok:false,falha:'transitorio',detalhe:'A leitura excedeu o tempo disponível; nenhum resultado parcial foi usado.'};

    // `paging.next` é entrada externa e pode carregar o próprio token. Nunca
    // seguir outro host nem encaminhar a credencial pela URL ou por redirect.
    let safeUrl: URL;
    try {
      safeUrl = new URL(url);
      if (safeUrl.origin !== 'https://graph.facebook.com' || safeUrl.username || safeUrl.password)
        throw new Error('origin');
      safeUrl.searchParams.delete('access_token');
    } catch {
      return { ok:false, falha:'transitorio', detalhe:'Paginação inválida da plataforma.' };
    }

    let resposta: Response;
    try {
      resposta = await fetch(safeUrl.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        // Sob demanda de verdade: a tela promete "Atualizar" e um cache aqui
        // devolveria número velho com cara de novo.
        cache: "no-store",
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1,Math.min(TEMPO_LIMITE_MS,deadline-Date.now()))),
      });
    } catch (erro) {
      return {
        ok: false,
        falha: "transitorio",
        detalhe: erro instanceof Error ? erro.message : "falha de rede",
      };
    }

    const texto = await resposta.text().catch(() => "");

    if (!resposta.ok) {
      let codigo: number | null = null;
      let mensagem = texto.slice(0, 400);
      try {
        const json = JSON.parse(texto) as ErroGraph;
        if (typeof json.error?.code === "number") codigo = json.error.code;
        if (json.error?.message) mensagem = json.error.message;
      } catch {
        // Corpo não-JSON num erro é gateway/WAF no meio. Fica o texto cru.
      }
      const falha = classificarErroGraph(resposta.status, codigo);
      // A mensagem da plataforma entra no log; o token, nunca — nem o `url`,
      // que a partir da segunda página o carrega na query.
      logger.warn("[ads.meta.insights] leitura recusada", {
        contexto,
        status: resposta.status,
        codigo,
        falha,
      });
      return { ok: false, falha, detalhe: mensagem };
    }

    let json: RespostaPaginada<T>;
    try {
      json = JSON.parse(texto) as RespostaPaginada<T>;
    } catch {
      return { ok: false, falha: "transitorio", detalhe: "resposta ilegível da plataforma" };
    }

    if (!Array.isArray(json.data)) return {ok:false,falha:'transitorio',detalhe:'Lista ausente na resposta da plataforma.'};
    acumulado.push(...json.data);
    url = json.paging?.next ?? null;
  }

  if (url) return {ok:false,falha:'transitorio',detalhe:'A leitura excedeu o limite de páginas; nenhum resultado parcial foi usado.'};
  return { ok: true, dados: acumulado };
}

function montarUrl(caminho: string, parametros: Record<string, string>): string {
  const url = new URL(`https://graph.facebook.com/${VERSAO_DA_API}/${caminho}`);
  for (const [chave, valor] of Object.entries(parametros)) {
    url.searchParams.set(chave, valor);
  }
  return url.toString();
}

/** As contas de anúncio que o token alcança. */
export async function listarContas(
  token: string,
): Promise<ResultadoDeLeitura<ContaDeAnuncio[]>> {
  const url = montarUrl("me/adaccounts", {
    fields: "account_id,name,currency,account_status",
    limit: "200",
  });

  interface ContaCrua {
    account_id?: string;
    name?: string;
    currency?: string;
    account_status?: number;
  }

  const resultado = await buscarPaginado<ContaCrua>(url, token, "adaccounts");
  if (!resultado.ok) return resultado;

  const contas = resultado.dados
    .filter((c): c is ContaCrua & { account_id: string } => Boolean(c.account_id))
    .map((c) => ({
      id: `act_${c.account_id}`,
      nome: c.name ?? c.account_id,
      moeda: c.currency ?? "BRL",
      status: typeof c.account_status === "number" ? c.account_status : 0,
    }));

  return { ok: true, dados: contas };
}

/**
 * As campanhas da conta, com `status` e `effective_status`.
 *
 * Chamada SEPARADA do insights, e não é escolha nossa: o endpoint de insights
 * não expõe estado de campanha. É por isso que a tela faz duas chamadas por
 * atualização, e é o que dobra o custo em cota.
 */
export async function lerCampanhas(
  token: string,
  contaId: string,
): Promise<ResultadoDeLeitura<CampanhaCrua[]>> {
  const url = montarUrl(`${encodeURIComponent(contaId)}/campaigns`, {
    fields: CAMPOS_DE_CAMPANHA,
    limit: "500",
  });
  return buscarPaginado<CampanhaCrua>(url, token, "campaigns");
}

/**
 * Os insights do período, no nível de campanha.
 *
 * `time_range` com datas explícitas em vez de `date_preset`: o preset é resolvido
 * no fuso da CONTA, e a tela oferece um seletor de intervalo que precisa
 * corresponder exatamente ao que foi pedido.
 */
export async function lerInsights(
  token: string,
  contaId: string,
  de: string,
  ate: string,
): Promise<ResultadoDeLeitura<LinhaDeInsightCrua[]>> {
  const url = montarUrl(`${encodeURIComponent(contaId)}/insights`, {
    level: "campaign",
    fields: CAMPOS_DE_INSIGHTS,
    time_range: JSON.stringify({ since: de, until: ate }),
    limit: "500",
  });
  return buscarPaginado<LinhaDeInsightCrua>(url, token, "insights");
}

/** Apenas o gasto diário, com todas as páginas antes de confirmar a cobertura. */
export async function lerGastoDiario(token:string,contaId:string,de:string,ate:string):Promise<ResultadoDeLeitura<Array<{
  campaign_id:string;campaign_name:string;day:string;amount_cents:number;currency:string;
}>>> {
  const result=await buscarPaginado<{campaign_id?:string;campaign_name?:string;date_start?:string;spend?:string;account_currency?:string}>(
    montarUrl(`${encodeURIComponent(contaId)}/insights`,{level:'campaign',fields:'campaign_id,campaign_name,date_start,spend,account_currency',
      time_range:JSON.stringify({since:de,until:ate}),time_increment:'1',limit:'500'}),token,'daily_spend');
  if(!result.ok)return result;
  const rows=[];
  const keys=new Set<string>();
  for(const row of result.dados) {
    // Não converter dinheiro com parseFloat silencioso nem aceitar uma moeda presumida.
    if(!row.campaign_id || !/^\d+$/.test(row.campaign_id) || !row.campaign_name
      || !row.date_start || !/^\d{4}-\d{2}-\d{2}$/.test(row.date_start) || row.date_start<de || row.date_start>ate
      || !row.account_currency || !/^[A-Z]{3}$/.test(row.account_currency) || !row.spend || !/^\d+(?:\.\d{1,2})?$/.test(row.spend))
      return {ok:false,falha:'transitorio',detalhe:'Gasto diário incompleto ou inválido; o cache anterior foi preservado.'};
    const [whole,decimal='']=row.spend.split('.');
    const cents=Number(whole)*100+Number(decimal.padEnd(2,'0'));
    const key=`${row.campaign_id}:${row.date_start}`;
    if(!Number.isSafeInteger(cents) || keys.has(key))return {ok:false,falha:'transitorio',detalhe:'Gasto diário duplicado ou fora do limite.'};
    keys.add(key);
    rows.push({campaign_id:row.campaign_id,campaign_name:row.campaign_name,day:row.date_start,amount_cents:cents,currency:row.account_currency});
  }
  return {ok:true,dados:rows};
}

/** Identidade real do anúncio; título e clique não são IDs de campanha. */
export async function lerIdentidadeDeAnuncio(token:string,adId:string):Promise<ResultadoDeLeitura<{
  ad_id:string;account_id:string;campaign_id:string;adset_id:string;
}>> {
  if(!/^\d+$/.test(adId))return {ok:false,falha:'campo_invalido',detalhe:'Identificador de anúncio inválido.'};
  const result=await lerObjeto<{id?:string;account_id?:string;campaign_id?:string;adset_id?:string}>(
    token,adId,'id,account_id,campaign_id,adset_id');
  if(!result.ok)return result;
  const ad=result.dados;
  if(ad.id!==adId || !ad.account_id || !/^\d+$/.test(ad.account_id) || !ad.campaign_id || !/^\d+$/.test(ad.campaign_id)
    || !ad.adset_id || !/^\d+$/.test(ad.adset_id))return {ok:false,falha:'campo_invalido',detalhe:'Anúncio não identificado com segurança.'};
  return {ok:true,dados:{ad_id:adId,account_id:`act_${ad.account_id}`,campaign_id:ad.campaign_id,adset_id:ad.adset_id}};
}

async function lerObjeto<T>(token:string,id:string,fields:string):Promise<ResultadoDeLeitura<T>> {
  try {
    const response=await fetch(montarUrl(encodeURIComponent(id),{fields}),{headers:{authorization:`Bearer ${token}`},
      cache:'no-store',redirect:'error',signal:AbortSignal.timeout(TEMPO_LIMITE_MS)});
    const json=await response.json();
    if(!response.ok)return {ok:false,falha:classificarErroGraph(response.status,json?.error?.code??null),detalhe:'A plataforma recusou a consulta.'};
    if(!json || typeof json!=='object' || Array.isArray(json))throw new Error('invalid');
    return {ok:true,dados:json as T};
  }catch{return {ok:false,falha:'transitorio',detalhe:'Não foi possível consultar a plataforma.'};}
}

export async function lerContaDoDashboard(token:string,accountId:string):Promise<ResultadoDeLeitura<{
  account_id:string;currency:string;timezone:string;
}>> {
  if(!/^act_\d+$/.test(accountId))return {ok:false,falha:'campo_invalido',detalhe:'Conta inválida.'};
  const result=await lerObjeto<{account_id?:string;currency?:string;timezone_name?:string}>(token,accountId,'account_id,currency,timezone_name');
  if(!result.ok)return result;
  const row=result.dados;
  if(`act_${row.account_id}`!==accountId || !row.currency || !/^[A-Z]{3}$/.test(row.currency) || !row.timezone_name)
    return {ok:false,falha:'campo_invalido',detalhe:'A plataforma não confirmou a moeda e o fuso da conta.'};
  try{new Intl.DateTimeFormat('en',{timeZone:row.timezone_name});}catch{return {ok:false,falha:'campo_invalido',detalhe:'Fuso da conta inválido.'};}
  return {ok:true,dados:{account_id:accountId,currency:row.currency,timezone:row.timezone_name}};
}
