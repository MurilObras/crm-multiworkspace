import { expect, it } from "vitest";
import { containsMediaLink } from "@/lib/agent-engine/agent/approved-media";

it.each([
  "https://example.test/demo.mp4",
  "https://example.test/a.ogg?signature=test",
  "https://youtu.be/example",
  "https://www.youtube.com/watch?v=demo",
  "https://example.test/storage/v1/object/sign/whatsapp-media/item",
  "https://example.test/demo%2Emp4",
])("não permite substituir catálogo por link: %s", (url) => {
  expect(containsMediaLink(`Você pode ver aqui: ${url}`)).toBe(true);
});
it.each([
  "https://example.test/assinar",
  "https://example.test/precos?plano=3",
  "https://notyoutube.com/assinar",
])("mantém links comerciais: %s", (url) => {
  expect(containsMediaLink(url)).toBe(false);
});
