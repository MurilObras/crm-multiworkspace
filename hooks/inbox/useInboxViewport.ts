"use client";

import { useEffect, type RefObject } from "react";

/** Reserva a área visível quando o teclado reduz só o visual viewport (iOS).
 * Pinch zoom continua sendo zoom: não recompõe a página numa viewport menor. */
export function useInboxViewport(ref: RefObject<HTMLDivElement | null>, enabled: boolean) {
  useEffect(() => {
    const element = ref.current;
    const viewport = window.visualViewport;
    if (!enabled || !element || !viewport) return;

    const update = () => {
      if (viewport.scale !== 1) {
        element.style.removeProperty("--inbox-viewport-height");
        return;
      }
      const top = Math.max(0, element.getBoundingClientRect().top - viewport.offsetTop);
      const available = Math.floor(viewport.height - top);
      const height = `${available}px`;
      if (available > 0 && element.style.getPropertyValue("--inbox-viewport-height") !== height) {
        element.style.setProperty("--inbox-viewport-height", height);
      }
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    // O body tem min-height:100vh: seu tamanho pode não mudar ao remover um
    // aviso ou com o teclado aberto. Observe também as caixas anteriores ao
    // shell e seus ancestrais, mesmo quando o wrapper usa display:contents.
    const layout = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const observeLayout = () => {
      layout?.disconnect();
      for (let node: Element | null = element; node?.parentElement; node = node.parentElement) {
        layout?.observe(node.parentElement);
        for (
          let sibling = node.previousElementSibling;
          sibling;
          sibling = sibling.previousElementSibling
        ) {
          layout?.observe(sibling);
        }
      }
      update();
    };
    // Só alterações nos irmãos/ancestrais recompõem a observação; mensagens
    // dentro da conversa não disparam esta leitura de layout.
    const structure = new MutationObserver(observeLayout);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      structure.observe(parent, { childList: true });
    }
    observeLayout();
    return () => {
      structure.disconnect();
      layout?.disconnect();
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      element.style.removeProperty("--inbox-viewport-height");
    };
  }, [enabled, ref]);
}
