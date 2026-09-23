import { describe, expect, it } from "vitest";
import type { MaterialAsset } from "../src/domain.ts";
import { collectPickedTiles, planDetailTiles, reconcileDetailTiles } from "../src/detail-tiles.ts";

function material(name: string): MaterialAsset {
  return {
    name,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    low: { url: "low", width: 512, height: 512, estimatedGpuBytes: 1_398_102 },
    medium: { url: "medium", width: 2048, height: 2048, estimatedGpuBytes: 22_369_622 },
    full: { url: "full", width: 8192, height: 8192, estimatedGpuBytes: 357_913_942 },
  };
}

describe("detail tile selection", () => {
  it("retains overlapping loaded tiles and requests only newly visible tiles", () => {
    const materials = [material("a")];
    const plan = planDetailTiles([
      { materialIndex: 0, x: 1, y: 0, size: 256, pixelCount: 10 },
      { materialIndex: 0, x: 2, y: 0, size: 256, pixelCount: 10 },
    ], materials, 10 * 1024 * 1024);
    const result = reconcileDetailTiles(new Set(["0:256:0:0", "0:256:1:0"]), plan.tiles);

    expect([...result.retained]).toEqual(["0:256:1:0"]);
    expect([...result.removed]).toEqual(["0:256:0:0"]);
    expect(result.missing.map(({ x }) => x)).toEqual([2]);
  });

  it("decodes every visible material and UV tile from the picking buffer", () => {
    const pixels = new Uint8Array([
      16, 16, 1, 0,
      240, 16, 1, 0,
      16, 240, 2, 0,
      0, 0, 0, 0,
    ]);
    const picked = collectPickedTiles(pixels, 2, 2, [material("a"), material("b")]);

    expect(picked.map(({ materialIndex, x, y, pixelCount }) => ({ materialIndex, x, y, pixelCount }))).toEqual([
      { materialIndex: 0, x: 2, y: 2, pixelCount: 1 },
      { materialIndex: 0, x: 30, y: 2, pixelCount: 1 },
      { materialIndex: 1, x: 2, y: 30, pixelCount: 1 },
    ]);
  });

  it("covers all 17 requested atlases as source-resolution tiles within the old atlas budget", () => {
    const materials = Array.from({ length: 17 }, (_, index) => material(`material-${index}`));
    const pixels = new Uint8Array(materials.flatMap((_asset, index) => [128, 128, index + 1, 0]));
    const picked = collectPickedTiles(pixels, 17, 1, materials);
    const plan = planDetailTiles(picked, materials, 1_400 * 1024 * 1024);

    expect(plan.tiles).toHaveLength(17);
    expect(plan.coveredPixels).toBe(plan.requestedPixels);
    expect(plan.coverage).toBe(1);
    expect(plan.estimatedGpuBytes).toBeLessThan(100 * 1024 * 1024);
  });

  it("prioritizes tiles covering the most screen pixels when a selection exceeds the budget", () => {
    const materials = [material("a"), material("b")];
    const picked = [
      { materialIndex: 0, x: 0, y: 0, size: 256, pixelCount: 10 },
      { materialIndex: 1, x: 0, y: 0, size: 256, pixelCount: 100 },
    ];
    const oneTileBudget = 400 * 1024;
    const plan = planDetailTiles(picked, materials, oneTileBudget);

    expect(plan.tiles).toHaveLength(1);
    expect(plan.tiles[0]?.materialIndex).toBe(1);
    expect(plan.coveredPixels).toBe(100);
    expect(plan.requestedPixels).toBe(110);
  });
});
