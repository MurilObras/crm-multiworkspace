// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CampaignsClient } from "@/app/app/campaigns/client";

const campaign = {
  id: "a0000000-0000-4000-8000-000000000001", name: "VIP", status: "running", hourly_limit: 10,
  steps: [{ message: "Hello {{literal}}", delay_minutes: 0 }],
};
let calls: Array<{ path: string; init?: RequestInit }>;
let launchFails = false;
let launchRejected = false;
beforeEach(() => {
  calls = []; launchFails = false; launchRejected = false;
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    let data: unknown;
    if (path.endsWith("/preview")) data = { total: 3, valid: 2, unique: 1, duplicates: 1, invalid: 1,
      contacts: [{ phone_number: "+5511987654321", name: "Maria" }] };
    else if (init?.method === "POST") {
      if (launchFails) throw new Error("Transport interrupted");
      if (launchRejected) return new Response(JSON.stringify({ error: { message: "Informe data futura." } }), { status: 422 });
      data = { id: campaign.id };
    } else if (path.includes("preview=1")) data = { count: 2 };
    else if (path.includes("?id=")) data = { campaign, counts: { pending: 1, sent: 1, failed: 0, skipped_opt_out: 0, stopped_reply: 0 }, recipients: [] };
    else data = { campaigns: [], channels: [{ id: "channel", phone_number: "Test channel" }] };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openForm() {
  render(<CampaignsClient canSend />);
  await screen.findByText("Nenhuma campanha criada.");
  fireEvent.click(screen.getByRole("button", { name: "Nova campanha" }));
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "VIP" } });
  fireEvent.change(screen.getByLabelText("Canal WhatsApp"), { target: { value: "channel" } });
  fireEvent.change(screen.getByLabelText(/Mensagem/), { target: { value: "Hello {{literal}}" } });
  fireEvent.change(screen.getByLabelText("Tag"), { target: { value: "vip" } });
}
it("requires a fresh server preview and invalidates it when audience changes", async () => {
  await openForm();
  expect(screen.getByRole("button", { name: "Enviar agora" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Calcular publico" }));
  await screen.findByText("2 contatos no recorte");
  expect(screen.getByRole("button", { name: "Enviar agora" })).toBeEnabled();
  fireEvent.change(screen.getByLabelText("Origem (opcional)"), { target: { value: "manual" } });
  expect(screen.getByRole("button", { name: "Enviar agora" })).toBeDisabled();
  expect(calls.some((c) => c.path.includes("preview=1&tag=vip"))).toBe(true);
});
it("send-now submits the first step with zero delay and shows five status counts", async () => {
  await openForm();
  fireEvent.click(screen.getByRole("button", { name: "Calcular publico" }));
  await screen.findByText("2 contatos no recorte");
  fireEvent.click(screen.getByRole("button", { name: "Enviar agora" }));
  await screen.findByText("Pendentes");
  expect(screen.getByText("Enviados")).toBeInTheDocument();
  expect(screen.getByText("Falhas")).toBeInTheDocument();
  expect(screen.getByText("Opt-out")).toBeInTheDocument();
  expect(screen.getByText("Parados (resposta)")).toBeInTheDocument();
  const posted = calls.find((c) => c.init?.method === "POST");
  expect(JSON.parse(String(posted?.init?.body))).toMatchObject({ steps: [{ message: "Hello {{literal}}", delay_minutes: 0 }], filters: { tag: "vip" } });
  expect(String(posted?.init?.body)).not.toContain("scheduled_at");
});
it("adds a second message with delay and converts the unit to minutes", async () => {
  await openForm();
  fireEvent.click(screen.getByRole("button", { name: "+ Adicionar mensagem" }));
  const messages = screen.getAllByLabelText(/Mensagem/);
  expect(messages).toHaveLength(2);
  fireEvent.change(screen.getByLabelText("Delay"), { target: { value: "2" } });
  fireEvent.change(screen.getByLabelText("Unidade"), { target: { value: "hours" } });
  fireEvent.change(messages[1]!, { target: { value: "Follow up" } });
  fireEvent.click(screen.getByRole("button", { name: "Calcular publico" }));
  await screen.findByText("2 contatos no recorte");
  fireEvent.click(screen.getByRole("button", { name: "Enviar agora" }));
  await screen.findByText("Pendentes");
  const posted = calls.find((c) => c.init?.method === "POST");
  expect(JSON.parse(String(posted?.init?.body)).steps).toEqual([
    { message: "Hello {{literal}}", delay_minutes: 0 },
    { message: "Follow up", delay_minutes: 120 },
  ]);
});
it("uncertain launch retries the same UUID and locks editing", async () => {
  await openForm(); launchFails = true;
  fireEvent.click(screen.getByRole("button", { name: "Calcular publico" }));
  await screen.findByText("2 contatos no recorte");
  fireEvent.click(screen.getByRole("button", { name: "Enviar agora" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Nome")).toBeDisabled();
  launchFails = false;
  fireEvent.click(screen.getByRole("button", { name: "Repetir com o mesmo ID" }));
  await waitFor(() => expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(2));
  const bodies = calls.filter((c) => c.init?.method === "POST").map((c) => JSON.parse(String(c.init?.body)));
  expect(bodies[0].id).toBe(bodies[1].id);
});
it("viewer can read but cannot open the launch form", async () => {
  render(<CampaignsClient canSend={false} />);
  await screen.findByText("Nenhuma campanha criada.");
  expect(screen.queryByRole("button", { name: "Nova campanha" })).not.toBeInTheDocument();
});
it("paste preview shows all counts and submits normalized unique contacts instead of raw text", async () => {
  await openForm();
  fireEvent.change(screen.getByLabelText("Publico"), { target: { value: "paste" } });
  fireEvent.change(screen.getByLabelText(/Numeros/), { target: { value: "11987654321;11987654321;bad" } });
  fireEvent.click(screen.getByRole("button", { name: "Calcular publico" }));
  await screen.findByText(/Total: 3.*Validos: 2.*Unicos: 1.*Duplicados: 1.*Invalidos: 1/);
  fireEvent.click(screen.getByRole("button", { name: "Enviar agora" }));
  await screen.findByText("Pendentes");
  const posted = calls.find((c) => c.path === "/api/v1/campaigns" && c.init?.method === "POST");
  const body = JSON.parse(String(posted?.init?.body));
  expect(body.audience).toEqual([{ phone_number: "+5511987654321", name: "Maria" }]);
  expect(body.filters).toBeUndefined(); expect(body.text).toBeUndefined();
});
it.each(["csv", "xlsx"])("file preview accepts %s and invalidates on replacement", async (extension) => {
  await openForm();
  fireEvent.change(screen.getByLabelText("Publico"), { target: { value: "file" } });
  fireEvent.change(screen.getByLabelText(/Planilha/), { target: { files: [new File(["fixture"], `audience.${extension}`)] } });
  fireEvent.click(screen.getByRole("button", { name: "Calcular publico" }));
  await screen.findByText(/Total: 3/);
  expect(calls.find((c) => c.path.endsWith("/preview"))?.init?.body).toBeInstanceOf(FormData);
  expect(screen.getByRole("button", { name: "Enviar agora" })).toBeEnabled();
  fireEvent.change(screen.getByLabelText(/Planilha/), { target: { files: [new File(["other"], `other.${extension}`)] } });
  expect(screen.getByRole("button", { name: "Enviar agora" })).toBeDisabled();
});
it("schedule converts explicit Sao Paulo wall time to UTC and preserves sequence", async () => {
  await openForm();
  fireEvent.change(screen.getByLabelText("Quando enviar"), { target: { value: "scheduled" } });
  fireEvent.change(screen.getByLabelText("Data e hora"), { target: { value: "2030-01-01T09:30" } });
  fireEvent.click(screen.getByRole("button", { name: "Calcular publico" }));
  await screen.findByText("2 contatos no recorte");
  fireEvent.click(screen.getByRole("button", { name: "Agendar campanha" }));
  await screen.findByText("Pendentes");
  const posted = calls.find((c) => c.init?.method === "POST");
  expect(JSON.parse(String(posted?.init?.body))).toMatchObject({ scheduled_at: "2030-01-01T12:30:00.000Z", steps: [{ message: "Hello {{literal}}", delay_minutes: 0 }] });
});
it("past schedule is rejected without locking the form or issuing a request", async () => {
  await openForm();
  fireEvent.change(screen.getByLabelText("Quando enviar"), { target: { value: "scheduled" } });
  fireEvent.change(screen.getByLabelText("Data e hora"), { target: { value: "2000-01-01T09:30" } });
  fireEvent.click(screen.getByRole("button", { name: "Calcular publico" }));
  await screen.findByText("2 contatos no recorte");
  fireEvent.click(screen.getByRole("button", { name: "Agendar campanha" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Data e hora")).toBeEnabled();
  expect(calls.some((c) => c.init?.method === "POST")).toBe(false);
});
it("database validation rejection allows fixing the schedule instead of locking a known rollback", async () => {
  await openForm(); launchRejected = true;
  fireEvent.change(screen.getByLabelText("Quando enviar"), { target: { value: "scheduled" } });
  fireEvent.change(screen.getByLabelText("Data e hora"), { target: { value: "2030-01-01T09:30" } });
  fireEvent.click(screen.getByRole("button", { name: "Calcular publico" }));
  await screen.findByText("2 contatos no recorte");
  fireEvent.click(screen.getByRole("button", { name: "Agendar campanha" }));
  await screen.findByText("Informe data futura.");
  expect(screen.getByLabelText("Data e hora")).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Repetir com o mesmo ID" })).not.toBeInTheDocument();
});
