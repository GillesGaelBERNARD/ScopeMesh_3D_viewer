export const ERROR_TILE_INDEX = 0xffffffff;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export interface DetailTileFrame {
  index: number;
  png: Uint8Array;
}

export function encodeTileFrame(index: number, png: Uint8Array): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > ERROR_TILE_INDEX || png.byteLength > MAX_FRAME_BYTES) {
    throw new Error("Invalid detail tile frame.");
  }
  const frame = new Uint8Array(8 + png.byteLength);
  const header = new DataView(frame.buffer);
  header.setUint32(0, index);
  header.setUint32(4, png.byteLength);
  frame.set(png, 8);
  return frame;
}

export async function* readTileFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<DetailTileFrame> {
  const reader = stream.getReader();
  let pending = new Uint8Array(0);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const joined = new Uint8Array(pending.length + value.length);
      joined.set(pending);
      joined.set(value, pending.length);
      pending = joined;
      while (pending.length >= 8) {
        const header = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
        const index = header.getUint32(0);
        const length = header.getUint32(4);
        if (length > MAX_FRAME_BYTES) throw new Error("Detail tile response contains an oversized frame.");
        if (pending.length < 8 + length) break;
        const png = pending.subarray(8, 8 + length);
        pending = pending.subarray(8 + length);
        if (index === ERROR_TILE_INDEX) throw new Error(new TextDecoder().decode(png));
        yield { index, png };
      }
    }
    if (pending.length > 0) throw new Error("Detail tile response ended mid-tile.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
