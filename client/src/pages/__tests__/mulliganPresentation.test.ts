import { describe, expect, it } from "vitest";

import { mulliganHandCardSizingStyle } from "../mulliganPresentation";

describe("mulliganHandCardSizingStyle", () => {
  it("sizes a seven-card opening hand against the full hand count", () => {
    expect(mulliganHandCardSizingStyle(7)).toEqual({
      "--card-w": "clamp(96px, calc((min(100vw, 72rem) - 6rem) / 7), 180px)",
      "--card-h": "calc(var(--card-w) * 1.4)",
    });
  });

  it("keeps the sizing expression valid for an empty transient hand", () => {
    expect(mulliganHandCardSizingStyle(0)).toEqual({
      "--card-w": "clamp(96px, calc((min(100vw, 72rem) - 6rem) / 1), 180px)",
      "--card-h": "calc(var(--card-w) * 1.4)",
    });
  });
});
