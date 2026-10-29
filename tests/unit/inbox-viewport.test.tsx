import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { useInboxViewport } from "@/hooks/inbox/useInboxViewport";

class Viewport extends EventTarget {
  height = 844;
  scale = 1;
  offsetTop = 0;
}

function Surface({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useInboxViewport(ref, enabled);
  return <div ref={ref} data-testid="surface" />;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("área visível do atendimento", () => {
  it("acompanha a redução pelo teclado e a recuperação ao fechar", () => {
    const viewport = new Viewport();
    vi.stubGlobal("visualViewport", viewport);
    render(<Surface />);
    const surface = screen.getByTestId("surface");
    expect(surface.style.getPropertyValue("--inbox-viewport-height")).toBe("844px");
    act(() => {
      viewport.height = 480;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(surface.style.getPropertyValue("--inbox-viewport-height")).toBe("480px");
    act(() => {
      viewport.height = 844;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(surface.style.getPropertyValue("--inbox-viewport-height")).toBe("844px");
  });

  it("mantém pinch zoom sem recompor a página pela largura ampliada", () => {
    const viewport = new Viewport();
    vi.stubGlobal("visualViewport", viewport);
    render(<Surface />);
    act(() => {
      viewport.scale = 2;
      viewport.height = 422;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByTestId("surface").style.getPropertyValue("--inbox-viewport-height")).toBe(
      "",
    );
  });

  it("desconta um aviso acima da área de atendimento", () => {
    const viewport = new Viewport();
    vi.stubGlobal("visualViewport", viewport);
    render(<Surface />);
    const surface = screen.getByTestId("surface");
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({ top: 40 } as DOMRect);
    act(() => viewport.dispatchEvent(new Event("resize")));
    expect(surface.style.getPropertyValue("--inbox-viewport-height")).toBe("804px");
  });

  it("deixa outras páginas intactas e limpa o ajuste ao sair do inbox", () => {
    const viewport = new Viewport();
    vi.stubGlobal("visualViewport", viewport);
    const { rerender } = render(<Surface />);
    const surface = screen.getByTestId("surface");
    rerender(<Surface enabled={false} />);
    act(() => {
      viewport.height = 480;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(surface.style.getPropertyValue("--inbox-viewport-height")).toBe("");
  });
});
