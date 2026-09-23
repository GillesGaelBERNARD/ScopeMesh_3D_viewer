import { describe, expect, it } from "vitest";
import { hasCompleteSourceTextureSet } from "../src/texture-streamer.ts";

describe("hasCompleteSourceTextureSet", () => {
  it("reports completion only when every expected texture is active at full resolution", () => {
    expect(hasCompleteSourceTextureSet(["full", "full"], 2)).toBe(true);
    expect(hasCompleteSourceTextureSet(["full", "medium"], 2)).toBe(false);
    expect(hasCompleteSourceTextureSet(["full"], 2)).toBe(false);
    expect(hasCompleteSourceTextureSet([], 0)).toBe(false);
  });
});
