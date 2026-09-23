import { describe, expect, it } from "vitest";
import { normalizedRect, rectanglesIntersect } from "../src/rectangle-selection.ts";

describe("screen rectangle selection", () => {
  it("normalizes drags in any direction", () => {
    expect(normalizedRect(80, 50, 20, 10)).toEqual({ left: 20, top: 10, right: 80, bottom: 50 });
  });

  it("selects overlapping regions, including edge contact", () => {
    const selection = { left: 10, top: 10, right: 50, bottom: 50 };
    expect(rectanglesIntersect(selection, { left: 40, top: 20, right: 80, bottom: 30 })).toBe(true);
    expect(rectanglesIntersect(selection, { left: 50, top: 50, right: 60, bottom: 60 })).toBe(true);
    expect(rectanglesIntersect(selection, { left: 51, top: 51, right: 60, bottom: 60 })).toBe(false);
  });
});

