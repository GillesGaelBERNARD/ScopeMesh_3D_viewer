import { describe, expect, it } from "vitest";
import type { MaterialAsset, QualityMode, TextureTier } from "../src/domain.ts";
import type { LodPlan, MaterialView } from "../src/lod-planner.ts";
import { needsAutomaticDetail } from "../src/automatic-detail.ts";

function material(fullSize = 8192, mediumSize = 2048): MaterialAsset {
  return {
    name: "reef",
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    low: { url: "low", width: 512, height: 512, estimatedGpuBytes: 1 },
    medium: { url: "medium", width: mediumSize, height: mediumSize, estimatedGpuBytes: 20 },
    full: { url: "full", width: fullSize, height: fullSize, estimatedGpuBytes: 100 },
  };
}

function scenario(mode: QualityMode, projectedPixels: number, tier: TextureTier, asset = material()): [MaterialView[], LodPlan, QualityMode] {
  return [[{ material: asset, visible: true, projectedPixels, selected: false }], {
    tiers: new Map([[asset.name, tier]]),
    dynamicBytes: 0,
    fullCount: tier === "full" ? 1 : 0,
    mediumCount: tier === "medium" ? 1 : 0,
  }, mode];
}

describe("automatic source detail", () => {
  it("activates when aggressive detail wants full resolution but the whole-texture plan had to fall back", () => {
    expect(needsAutomaticDetail(...scenario("detail", 900, "medium"))).toBe(true);
  });

  it("stays off when the whole-texture plan already provides full resolution", () => {
    expect(needsAutomaticDetail(...scenario("detail", 900, "full"))).toBe(false);
  });

  it("stays off before the aggressive full-detail threshold", () => {
    expect(needsAutomaticDetail(...scenario("detail", 500, "medium"))).toBe(false);
  });

  it("stays off outside aggressive detail mode", () => {
    expect(needsAutomaticDetail(...scenario("auto", 2000, "medium"))).toBe(false);
  });

  it("does not duplicate tiles when the source has no more pixels than the planned tier", () => {
    expect(needsAutomaticDetail(...scenario("detail", 900, "medium", material(2048, 2048)))).toBe(false);
  });
});
