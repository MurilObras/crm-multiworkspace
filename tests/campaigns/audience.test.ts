// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { previewAudience } from "@/lib/campaigns/audience";
import { parseCsv } from "@/lib/contacts/csv";
import { POST } from "@/app/api/v1/campaigns/preview/route";
import { sidebarGroups, searchable } from "@/lib/navigation/registry";

const { requireRole } = vi.hoisted(() => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole }));
beforeEach(() => requireRole.mockResolvedValue({ ok: true }));

it("paste normalizes lines, commas, semicolons, ninth digit, duplicates and invalids", () => {
  expect(previewAudience("(32) 8479-3302, +5532984793302;invalid\n11 98765-4321\n")).toEqual({
    total: 4, valid: 3, unique: 2, duplicates: 1, invalid: 1,
    contacts: [{ phone_number: "+5532984793302" }, { phone_number: "+5511987654321" }],
  });
});
it("CSV uses existing aliases and quoted delimiter parser, ignores invalid extras", () => {
  expect(previewAudience(parseCsv('Telefone;Nome;email\n11987654321;"Maria; Silva";bad\n+5511987654321;Duplicate;bad\ninvalid;No;bad'))).toEqual({
    total: 3, valid: 2, unique: 1, duplicates: 1, invalid: 1,
    contacts: [{ phone_number: "+5511987654321", name: "Maria; Silva" }],
  });
  expect(() => previewAudience([["email"], ["valid@example.test"]])).toThrow("coluna telefone");
  expect(() => previewAudience(Array.from({ length: 501 }, () => "11987654321").join("\n"))).toThrow("500");
});

function upload(bytes: Uint8Array | string, name: string) {
  const body = new FormData();
  body.set("file", new File([typeof bytes === "string" ? bytes : Uint8Array.from(bytes).buffer], name));
  return new Request("http://localhost/api/v1/campaigns/preview", { method: "POST", body });
}
it("preview POST handles paste and CSV without DB creation", async () => {
  const response = await POST(new Request("http://localhost/api/v1/campaigns/preview", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "11987654321;bad" }) }));
  expect((await response.json()).data).toMatchObject({ unique: 1, invalid: 1 });
  const csv = await POST(upload("telefone,nome,ignored\n11987654321,Maria,anything", "audience.csv"));
  expect(csv.status).toBe(200);
  expect((await csv.json()).data.contacts).toEqual([{ phone_number: "+5511987654321", name: "Maria" }]);
});
it("XLSX is parsed from real zipped workbook bytes, numeric phones and optional names", async () => {
  const files = {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    "xl/workbook.xml": '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Audience" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>telefone</t></is></c><c r="B1" t="inlineStr"><is><t>nome</t></is></c></row><row r="2"><c r="A2"><v>11987654321</v></c><c r="B2" t="inlineStr"><is><t>Maria</t></is></c></row><row r="3"><c r="A3"><v>11987654321</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>bad</t></is></c></row></sheetData></worksheet>',
  };
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
  const response = await POST(upload(zip, "audience.xlsx"));
  expect(response.status).toBe(200);
  expect((await response.json()).data).toEqual({ total: 3, valid: 2, unique: 1, duplicates: 1, invalid: 1,
    contacts: [{ phone_number: "+5511987654321", name: "Maria" }] });
});
it("preview rejects unsupported, corrupt, oversized and unauthorized uploads", async () => {
  expect((await POST(upload("bad", "bad.xlsx"))).status).toBe(422);
  expect((await POST(upload("bad", "bad.exe"))).status).toBe(422);
  expect((await POST(upload("email\na@example.test", "bad.csv"))).status).toBe(422);
  expect((await POST(upload(new Uint8Array(5 * 1024 * 1024 + 1), "large.csv"))).status).toBe(413);
  requireRole.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await POST(upload("telefone\n11987654321", "ok.csv"))).status).toBe(403);
});
it("campaigns is in sidebar and search for every authenticated tenant role, never without role", () => {
  for (const role of ["viewer", "agent", "manager", "admin"] as const) {
    expect(sidebarGroups(false, role).flatMap((g) => g.items).some((d) => d.href === "/app/campaigns")).toBe(true);
    expect(searchable(false, role).some((d) => d.href === "/app/campaigns")).toBe(true);
  }
  expect(sidebarGroups(false, null)).toEqual([]);
});
