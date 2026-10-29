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

  it("acompanha entrada e saída de aviso sem resize da viewport", () => {
    const viewport = new Viewport();
    vi.stubGlobal("visualViewport", viewport);
    let atualizarLayout = () => {};
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          atualizarLayout = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    );
    render(<Surface />);
    const surface = screen.getByTestId("surface");
    const bounds = vi.spyOn(surface, "getBoundingClientRect");
    expect(observe).toHaveBeenCalledWith(document.body);
    bounds.mockReturnValue({ top: 40 } as DOMRect);
    act(atualizarLayout);
    expect(surface.style.getPropertyValue("--inbox-viewport-height")).toBe("804px");
    bounds.mockReturnValue({ top: 0 } as DOMRect);
    act(atualizarLayout);
    expect(surface.style.getPropertyValue("--inbox-viewport-height")).toBe("844px");
    cleanup();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("detecta aviso inserido/removido mantendo o body com altura mínima", async () => {
    const viewport = new Viewport();
    viewport.height = 480;
    vi.stubGlobal("visualViewport", viewport);
    const observe = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = observe;
        disconnect() {}
      },
    );
    document.body.style.minHeight = "844px";
    render(<Surface />);
    const surface = screen.getByTestId("surface");
    const bounds = vi.spyOn(surface, "getBoundingClientRect");
    const banner = document.createElement("div");
    bounds.mockReturnValue({ top: 40 } as DOMRect);
    await act(async () => {
      surface.before(banner);
    });
    expect(observe).toHaveBeenCalledWith(banner);
    expect(surface.style.getPropertyValue("--inbox-viewport-height")).toBe("440px");
    bounds.mockReturnValue({ top: 0 } as DOMRect);
    await act(async () => {
      banner.remove();
    });
    expect(surface.style.getPropertyValue("--inbox-viewport-height")).toBe("480px");
    document.body.style.removeProperty("min-height");
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
