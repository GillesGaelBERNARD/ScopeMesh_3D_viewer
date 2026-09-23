import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { generateTileBand } from "../detail-tile-batch.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("detail tile band generation", () => {
  it("produces exact source pixels and reports each tile as it is ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "reefstream-band-"));
    roots.push(root);
    const width = 1300;
    const height = 1300;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 3;
        pixels[offset] = x % 256;
        pixels[offset + 1] = y % 256;
        pixels[offset + 2] = (x + y) % 256;
      }
    }
    const source = join(root, "source.png");
    await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(source);
    const requested = [
      { index: 3, left: 12, top: 766, width: 260, height: 260 },
      { index: 0, left: 800, top: 510, width: 260, height: 260 },
    ];
    const completed: number[] = [];

    await generateTileBand(source, width, height, 0, requested, async (tile, png) => {
      completed.push(tile.index);
      const result = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      expect(result.info.width).toBe(tile.width);
      expect(result.info.height).toBe(tile.height);
      for (const [x, y] of [[0, 0], [tile.width - 1, tile.height - 1], [50, 80]] as const) {
        const actual = (y * tile.width + x) * 3;
        const expected = ((tile.top + y) * width + tile.left + x) * 3;
        expect([...result.data.subarray(actual, actual + 3)]).toEqual([...pixels.subarray(expected, expected + 3)]);
      }
    });

    expect(completed).toEqual([0, 3]);
  });
});
