import sharp from "sharp";

export const DETAIL_BAND_HEIGHT = 1024;
const DETAIL_BAND_GUTTER = 2;

export interface BandTile {
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export async function generateTileBand(
  sourcePath: string,
  sourceWidth: number,
  sourceHeight: number,
  bandIndex: number,
  tiles: BandTile[],
  onTile: (tile: BandTile, png: Buffer) => Promise<void>,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  const allowedTop = Math.max(0, bandIndex * DETAIL_BAND_HEIGHT - DETAIL_BAND_GUTTER);
  const allowedBottom = Math.min(sourceHeight, (bandIndex + 1) * DETAIL_BAND_HEIGHT + DETAIL_BAND_GUTTER);
  if (tiles.length === 0 || tiles.some((tile) =>
    tile.left < 0 || tile.top < allowedTop || tile.left + tile.width > sourceWidth || tile.top + tile.height > allowedBottom
  )) throw new Error("Detail tile lies outside its source band.");

  if (isCancelled()) return;
  const bandLeft = Math.min(...tiles.map((tile) => tile.left));
  const bandRight = Math.max(...tiles.map((tile) => tile.left + tile.width));
  const bandTop = Math.min(...tiles.map((tile) => tile.top));
  const bandBottom = Math.max(...tiles.map((tile) => tile.top + tile.height));

  const band = await sharp(sourcePath, { limitInputPixels: false, sequentialRead: true })
    .extract({ left: bandLeft, top: bandTop, width: bandRight - bandLeft, height: bandBottom - bandTop })
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (const tile of [...tiles].sort((a, b) => a.index - b.index)) {
    if (isCancelled()) return;
    const png = await sharp(band.data, {
      raw: { width: band.info.width, height: band.info.height, channels: band.info.channels },
    })
      .extract({ left: tile.left - bandLeft, top: tile.top - bandTop, width: tile.width, height: tile.height })
      .png({ compressionLevel: 6, adaptiveFiltering: true })
      .toBuffer();
    await onTile(tile, png);
  }
}
