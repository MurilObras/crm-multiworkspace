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
      if (available > 0) element.style.setProperty("--inbox-viewport-height", `${available}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      element.style.removeProperty("--inbox-viewport-height");
    };
  }, [enabled, ref]);
}
