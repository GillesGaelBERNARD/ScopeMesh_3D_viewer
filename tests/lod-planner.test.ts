import { describe, expect, it } from "vitest";
import type { MaterialAsset } from "../src/domain.ts";
import { planTextureTiers, projectedPixelDiameter } from "../src/lod-planner.ts";

function material(name: string, mediumBytes = 20, fullBytes = 100): MaterialAsset {
  return {
    name,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    low: { url: "low", width: 1, height: 1, estimatedGpuBytes: 1 },
    medium: { url: "medium", width: 2, height: 2, estimatedGpuBytes: mediumBytes },
    full: { url: "full", width: 4, height: 4, estimatedGpuBytes: fullBytes },
  };
}

describe("projectedPixelDiameter", () => {
  it("grows as the camera approaches the same reef section", () => {
    expect(projectedPixelDiameter(1, 5, Math.PI / 2, 1000)).toBeCloseTo(200);
    expect(projectedPixelDiameter(1, 10, Math.PI / 2, 1000)).toBeCloseTo(100);
  });
});

describe("planTextureTiers", () => {
  it.each(["auto", "detail"] as const)("loads the complete source texture set in %s mode when it fits the configured budget", (mode) => {
    const first = material("first", 20, 100);
    const second = material("second", 20, 100);
    const plan = planTextureTiers([
      { material: first, visible: false, projectedPixels: 0, selected: false },
      { material: second, visible: true, projectedPixels: 10, selected: false },
    ], mode, 200);

    expect(plan.tiers.get("first")).toBe("full");
    expect(plan.tiers.get("second")).toBe("full");
    expect(plan.fullCount).toBe(2);
    expect(plan.dynamicBytes).toBe(200);
  });

  it("keeps invisible and overview sections at the resident low tier", () => {
    const reef = material("reef");
    const plan = planTextureTiers([{ material: reef, visible: true, projectedPixels: 5000, selected: false }], "overview", 1000);
    expect(plan.tiers.get("reef")).toBe("low");
    expect(plan.dynamicBytes).toBe(0);
  });

  it("spends its budget on the most important visible sections", () => {
    const selected = material("selected", 20, 100);
    const large = material("large", 20, 100);
    const plan = planTextureTiers([
      { material: large, visible: true, projectedPixels: 2000, selected: false },
      { material: selected, visible: true, projectedPixels: 500, selected: true },
    ], "auto", 120);
    expect(plan.tiers.get("selected")).toBe("full");
    expect(plan.tiers.get("large")).toBe("medium");
    expect(plan.dynamicBytes).toBe(120);
  });

  it("falls back from full to medium rather than exceeding the GPU budget", () => {
    const reef = material("reef", 20, 100);
    const plan = planTextureTiers([{ material: reef, visible: true, projectedPixels: 2000, selected: false }], "auto", 50);
    expect(plan.tiers.get("reef")).toBe("medium");
    expect(plan.dynamicBytes).toBe(20);
  });
});
