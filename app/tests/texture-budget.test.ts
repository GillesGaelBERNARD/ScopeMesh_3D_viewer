import { describe, expect, it } from "vitest";
import { DEFAULT_TEXTURE_BUDGET_MIB, MAX_TEXTURE_BUDGET_MIB, textureBudgets } from "../src/texture-budget.ts";

describe("textureBudgets", () => {
  it("defaults to a safe 2 GiB budget for a 4 GiB GPU", () => {
    expect(DEFAULT_TEXTURE_BUDGET_MIB).toBe(2048);
    expect(textureBudgets(DEFAULT_TEXTURE_BUDGET_MIB)).toEqual({
      totalMiB: 2048,
      normalBytes: 2048 * 1024 * 1024,
      backgroundBytes: 512 * 1024 * 1024,
      detailBytes: 1536 * 1024 * 1024,
    });
  });

  it("clamps unsafe values to the supported slider range", () => {
    expect(textureBudgets(100).totalMiB).toBe(512);
    expect(MAX_TEXTURE_BUDGET_MIB).toBe(12 * 1024);
    expect(textureBudgets(99_999).totalMiB).toBe(12 * 1024);
  });
});
