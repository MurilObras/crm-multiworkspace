import { describe, expect, it } from "vitest";
import { collectApprovedMediaUrls } from "@/lib/agent-engine/agent/approved-media";

describe("arquivos aprovados no material do agente", () => {
  it("extrai URL exata de texto e Markdown, sem pontuação de fechamento", () => {
    expect(
      collectApprovedMediaUrls(
        "Vídeo: https://example.test/intro.mp4. [Foto](https://example.test/photo.jpg)",
      ),
    ).toEqual(["https://example.test/intro.mp4", "https://example.test/photo.jpg"]);
  });
  it("não autoriza subdomínio, caminho parecido ou outro protocolo", () => {
    const urls = new Set(collectApprovedMediaUrls("https://example.test/intro.mp4"));
    expect(urls.has("https://other.example.test/intro.mp4")).toBe(false);
    expect(urls.has("https://example.test/intro.mp4/private")).toBe(false);
    expect(collectApprovedMediaUrls("http://example.test/a.jpg file:///secret")).toEqual([]);
  });
});
