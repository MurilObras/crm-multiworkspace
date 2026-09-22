import { render,screen,fireEvent,waitFor,cleanup } from "@testing-library/react";
import { QueryClient,QueryClientProvider } from "@tanstack/react-query";
import { afterEach,it,expect,vi } from "vitest";
import { KiwifyHistoryTab } from "./KiwifyHistoryTab";
import type { KiwifyHistoryRow } from "@/lib/automation/kiwify-history";
vi.mock("@/hooks/i18n/useT",()=>({useT:()=> (s:string)=>s}));
const row: KiwifyHistoryRow = {
  receipt_id:"receipt",run_id:"run",order_id:"SYNTHETIC-001",intake_status:"accepted",lead_id:"lead",lead_title:"Compra sintética",
  contact_id:"contact",contact_name:"Pessoa sintética",current_phone:"+12025550102",destination_phone:"+12025550101",
  product_id:"product",product_name:"Produto sintético",rule_name:"Aviso de compra",action_type:"send_whatsapp_message",action_index:0,
  channel:"synthetic",conversation_id:"conversation",message_id:"message",provider_id:"synthetic-provider",
  attempted_at:"2026-09-20T10:00:00Z",created_at:"2026-09-20T10:00:00Z",updated_at:"2026-09-20T10:01:00Z",status:"uncertain",
  contact_blocked:false,reason:null,
};
/** Roteia o fetch por URL: histórico de um lado, canais (usados pelo diálogo de envio) de outro. */
function fetchRouter(rows: KiwifyHistoryRow[], hasMore = false) {
  return vi.fn(async (...args: unknown[]) => {
    const url = String(args[0]);
    if (url.includes("/api/v1/channel-sessions")) return Response.json({ data: [] });
    return Response.json({ data: { rows, has_more: hasMore } });
  });
}
function mount() { return render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})}><KiwifyHistoryTab organizationId="synthetic-org" /></QueryClientProvider>); }
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it("mostra destinatário da tentativa separado do atual, aviso incerto e somente links existentes",async()=>{
  vi.stubGlobal("fetch",fetchRouter([row]));mount();
  await screen.findByRole("heading",{name:"Compra SYNTHETIC-001"});
  expect(screen.getByText("+12025550101")).toBeVisible();expect(screen.getByText("+12025550102")).toBeVisible();
  expect(screen.getByText("Confira a conversa antes de enviar manualmente: o cliente pode já ter recebido.")).toBeVisible();
  expect(screen.getByRole("link",{name:"Abrir lead"})).toHaveAttribute("href","/app/leads/lead");
  expect(screen.getByRole("link",{name:"Abrir contato"})).toHaveAttribute("href","/app/contacts/contact");
  expect(screen.getByRole("link",{name:"Abrir conversa"})).toHaveAttribute("href","/app/inbox/conversation");
  expect(screen.queryByRole("button",{name:/reenviar|tentar novamente|cancelar|editar/i})).toBeNull();
});
it("compra válida com contato elegível oferece envio manual",async()=>{
  vi.stubGlobal("fetch",fetchRouter([row]));mount();
  await screen.findByRole("heading",{name:"Compra SYNTHETIC-001"});
  expect(screen.getByRole("button",{name:"Enviar mensagem"})).toBeVisible();
});
it("compra sem contato/telefone elegível não oferece envio manual",async()=>{
  vi.stubGlobal("fetch",fetchRouter([{...row,contact_id:null,current_phone:null,conversation_id:null}]));mount();
  await screen.findByRole("heading",{name:"Compra SYNTHETIC-001"});
  expect(screen.queryByRole("button",{name:"Enviar mensagem"})).toBeNull();
});
it("compra com contato bloqueado não oferece envio manual",async()=>{
  vi.stubGlobal("fetch",fetchRouter([{...row,contact_blocked:true}]));mount();
  await screen.findByRole("heading",{name:"Compra SYNTHETIC-001"});
  expect(screen.queryByRole("button",{name:"Enviar mensagem"})).toBeNull();
});
it("recusa de consentimento não sugere envio manual; ausência de dados não inventa cadastro",async()=>{
  vi.stubGlobal("fetch",fetchRouter([{...row,status:"blocked",reason:"consent_declined",contact_name:null,current_phone:null,destination_phone:null,contact_id:null,conversation_id:null}]));mount();
  await screen.findByText("O contato recusou o consentimento. Envio bloqueado.");
  expect(screen.queryByText(/Confira a conversa antes/)).toBeNull();
  expect(screen.queryByRole("link",{name:"Abrir conversa"})).toBeNull();
  expect(screen.queryByRole("link",{name:"Abrir contato"})).toBeNull();
  expect(screen.queryByRole("button",{name:"Enviar mensagem"})).toBeNull();
  expect(screen.getAllByText("Não disponível").length).toBeGreaterThan(0);
});
it("busca, situação, datas e paginação geram apenas consultas GET",async()=>{
  const fetch=fetchRouter([row],true);vi.stubGlobal("fetch",fetch);mount();
  await screen.findByRole("heading");fireEvent.click(screen.getByRole("button",{name:"Próxima"}));
  await waitFor(()=>expect(fetch.mock.calls.some(c=>String(c[0]).includes("page=2"))).toBe(true));
  fireEvent.change(screen.getByLabelText("Compra, nome ou telefone"),{target:{value:"SYNTHETIC"}});
  fireEvent.change(screen.getByLabelText("Situação"),{target:{value:"uncertain"}});
  fireEvent.change(screen.getByLabelText("De (UTC)"),{target:{value:"2026-09-01"}});
  fireEvent.change(screen.getByLabelText("Até (UTC)"),{target:{value:"2026-09-30"}});
  await waitFor(()=>expect(fetch.mock.calls.some(c=>String(c[0]).includes("to=2026-09-30"))).toBe(true));
  expect(fetch.mock.calls.every(c=>{
    const method = (c[1] as RequestInit | undefined)?.method;
    return !method || method === "GET";
  })).toBe(true);
});
it("apresenta carregamento e erro sem controles de reenvio",async()=>{
  let reject!: (error:Error)=>void;
  vi.stubGlobal("fetch",()=>new Promise((_resolve,r)=>{reject=r;}));mount();
  expect(screen.getByLabelText("Carregando histórico")).toBeVisible();reject(new Error("synthetic"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível consultar");
});
it("apresenta lista vazia",async()=>{
  vi.stubGlobal("fetch",fetchRouter([]));mount();
  expect(await screen.findByText("Nenhuma compra encontrada para esses filtros.")).toBeVisible();
});
