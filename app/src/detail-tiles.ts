import { estimateGpuBytes, type MaterialAsset } from "./domain.ts";

export const DETAIL_TILE_SIZE = 256;
export const MAX_DETAIL_TILE_SIZE = 1024;
export const DETAIL_TILE_GUTTER = 2;

export interface PickedDetailTile {
  materialIndex: number;
  x: number;
  y: number;
  size: number;
  pixelCount: number;
}

export interface PlannedDetailTile extends PickedDetailTile {
  estimatedGpuBytes: number;
  cropPixels: { left: number; top: number; width: number; height: number };
  coreUv: [number, number, number, number];
  cropUv: [number, number, number, number];
}

export interface DetailTilePlan {
  tiles: PlannedDetailTile[];
  totalTiles: number;
  estimatedGpuBytes: number;
  requiredGpuBytes: number;
  requestedPixels: number;
  coveredPixels: number;
  coverage: number;
}

export function detailTileKey(materialIndex: number, size: number, x: number, y: number): string {
  return `${materialIndex}:${size}:${x}:${y}`;
}

export interface DetailTileReconciliation {
  retained: Set<string>;
  removed: Set<string>;
  missing: PlannedDetailTile[];
}

export function reconcileDetailTiles(
  existingKeys: ReadonlySet<string>,
  planned: PlannedDetailTile[],
): DetailTileReconciliation {
  const plannedKeys = new Set(planned.map((tile) => detailTileKey(tile.materialIndex, tile.size, tile.x, tile.y)));
  const retained = new Set([...existingKeys].filter((key) => plannedKeys.has(key)));
  const removed = new Set([...existingKeys].filter((key) => !plannedKeys.has(key)));
  const missing = planned.filter((tile) => !existingKeys.has(detailTileKey(tile.materialIndex, tile.size, tile.x, tile.y)));
  return { retained, removed, missing };
}

export function collectPickedTiles(
  pixels: Uint8Array,
  width: number,
  height: number,
  materials: MaterialAsset[],
  tileSize = DETAIL_TILE_SIZE,
): PickedDetailTile[] {
  if (pixels.length !== width * height * 4) throw new Error("Picking buffer dimensions do not match its pixel data.");
  const picked = new Map<string, PickedDetailTile>();
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const encodedMaterial = pixels[offset + 2]! + pixels[offset + 3]! * 256;
    if (encodedMaterial === 0) continue;
    const materialIndex = encodedMaterial - 1;
    const material = materials[materialIndex];
    if (!material) continue;
    const columns = Math.ceil(material.full.width / tileSize);
    const rows = Math.ceil(material.full.height / tileSize);
    const u = pixels[offset]! / 255;
    const v = pixels[offset + 1]! / 255;
    const x = Math.min(columns - 1, Math.floor(u * columns));
    const y = Math.min(rows - 1, Math.floor(v * rows));
    const key = detailTileKey(materialIndex, tileSize, x, y);
    const existing = picked.get(key);
    if (existing) existing.pixelCount += 1;
    else picked.set(key, { materialIndex, x, y, size: tileSize, pixelCount: 1 });
  }
  return [...picked.values()].sort((a, b) =>
    a.materialIndex - b.materialIndex || a.size - b.size || a.y - b.y || a.x - b.x,
  );
}

export function compactPickedTiles(
  picked: PickedDetailTile[],
  materials: MaterialAsset[],
  maximumSize = MAX_DETAIL_TILE_SIZE,
): PickedDetailTile[] {
  const tiles = new Map(picked.map((tile) => [detailTileKey(tile.materialIndex, tile.size, tile.x, tile.y), { ...tile }]));
  const minimumSize = Math.min(...picked.map((tile) => tile.size), DETAIL_TILE_SIZE);
  for (let childSize = minimumSize; childSize * 2 <= maximumSize; childSize *= 2) {
    const groups = new Map<string, PickedDetailTile[]>();
    for (const tile of tiles.values()) {
      if (tile.size !== childSize) continue;
      const key = `${tile.materialIndex}:${Math.floor(tile.x / 2)}:${Math.floor(tile.y / 2)}`;
      const siblings = groups.get(key) ?? [];
      siblings.push(tile);
      groups.set(key, siblings);
    }
    for (const siblings of groups.values()) {
      const first = siblings[0];
      if (!first) continue;
      const material = materials[first.materialIndex];
      if (!material) continue;
      const parentX = Math.floor(first.x / 2);
      const parentY = Math.floor(first.y / 2);
      const childColumns = Math.ceil(material.full.width / childSize);
      const childRows = Math.ceil(material.full.height / childSize);
      const expected: string[] = [];
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const x = parentX * 2 + dx;
          const y = parentY * 2 + dy;
          if (x < childColumns && y < childRows) expected.push(detailTileKey(first.materialIndex, childSize, x, y));
        }
      }
      if (!expected.every((key) => tiles.has(key))) continue;
      const children = expected.map((key) => tiles.get(key)!);
      for (const key of expected) tiles.delete(key);
      const parentSize = childSize * 2;
      tiles.set(detailTileKey(first.materialIndex, parentSize, parentX, parentY), {
        materialIndex: first.materialIndex,
        x: parentX,
        y: parentY,
        size: parentSize,
        pixelCount: children.reduce((sum, child) => sum + child.pixelCount, 0),
      });
    }
  }
  return [...tiles.values()];
}

function describeTile(
  tile: PickedDetailTile,
  material: MaterialAsset,
  gutter: number,
): PlannedDetailTile {
  const tileSize = tile.size;
  const coreLeft = tile.x * tileSize;
  const coreTop = tile.y * tileSize;
  const coreRight = Math.min(material.full.width, coreLeft + tileSize);
  const coreBottom = Math.min(material.full.height, coreTop + tileSize);
  const cropLeft = Math.max(0, coreLeft - gutter);
  const cropTop = Math.max(0, coreTop - gutter);
  const cropRight = Math.min(material.full.width, coreRight + gutter);
  const cropBottom = Math.min(material.full.height, coreBottom + gutter);
  const width = cropRight - cropLeft;
  const height = cropBottom - cropTop;
  return {
    ...tile,
    estimatedGpuBytes: estimateGpuBytes(width, height),
    cropPixels: { left: cropLeft, top: cropTop, width, height },
    coreUv: [
      coreLeft / material.full.width,
      coreTop / material.full.height,
      coreRight / material.full.width,
      coreBottom / material.full.height,
    ],
    cropUv: [
      cropLeft / material.full.width,
      cropTop / material.full.height,
      cropRight / material.full.width,
      cropBottom / material.full.height,
    ],
  };
}

export function planDetailTiles(
  picked: PickedDetailTile[],
  materials: MaterialAsset[],
  budgetBytes: number,
  gutter = DETAIL_TILE_GUTTER,
): DetailTilePlan {
  const requestedPixels = picked.reduce((sum, tile) => sum + tile.pixelCount, 0);
  const candidates = compactPickedTiles(picked, materials)
    .map((tile) => {
      const material = materials[tile.materialIndex];
      return material ? describeTile(tile, material, gutter) : undefined;
    })
    .filter((tile): tile is PlannedDetailTile => Boolean(tile))
    .sort((a, b) => b.pixelCount - a.pixelCount || a.materialIndex - b.materialIndex || a.y - b.y || a.x - b.x);
  const tiles: PlannedDetailTile[] = [];
  let estimatedGpuBytes = 0;
  let coveredPixels = 0;
  const requiredGpuBytes = candidates.reduce((sum, tile) => sum + tile.estimatedGpuBytes, 0);
  for (const tile of candidates) {
    if (estimatedGpuBytes + tile.estimatedGpuBytes > budgetBytes) continue;
    tiles.push(tile);
    estimatedGpuBytes += tile.estimatedGpuBytes;
    coveredPixels += tile.pixelCount;
  }
  return {
    tiles,
    totalTiles: candidates.length,
    estimatedGpuBytes,
    requiredGpuBytes,
    requestedPixels,
    coveredPixels,
    coverage: requestedPixels === 0 ? 1 : coveredPixels / requestedPixels,
  };
}
