import type { CSSProperties } from "react";

/**
 * Opening-hand cards are a comparison surface, not the normal in-game hand.
 * Size them against the mulligan panel's 72rem maximum width so the complete
 * hand remains visible without horizontal scrolling on ordinary desktop
 * viewports. The normal hand fan keeps its independent battlefield-first sizing.
 */
export function mulliganHandCardSizingStyle(handCount: number): CSSProperties {
  const visibleCount = Math.max(1, handCount);
  return {
    "--card-w": `clamp(96px, calc((min(100vw, 72rem) - 6rem) / ${visibleCount}), 180px)`,
    "--card-h": "calc(var(--card-w) * 1.4)",
  } as CSSProperties;
}
