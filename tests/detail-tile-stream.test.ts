import { describe, expect, it } from "vitest";
import { encodeTileFrame, ERROR_TILE_INDEX, readTileFrames } from "../src/detail-tile-stream.ts";

function chunkedStream(bytes: Uint8Array, sizes: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      let offset = 0;
      for (const size of sizes) {
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset += size;
      }
      if (offset < bytes.length) controller.enqueue(bytes.subarray(offset));
      controller.close();
    },
  });
}

describe("progressive detail tile stream", () => {
  it("yields a completed tile before the response finishes", async () => {
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
    const frames = readTileFrames(stream);
    const first = frames.next();
    writer.enqueue(encodeTileFrame(0, Uint8Array.from([7])));

    expect(await first).toEqual({ done: false, value: { index: 0, png: Uint8Array.from([7]) } });
    writer.enqueue(encodeTileFrame(1, Uint8Array.from([8])));
    writer.close();
    expect(await frames.next()).toEqual({ done: false, value: { index: 1, png: Uint8Array.from([8]) } });
    expect((await frames.next()).done).toBe(true);
  });

  it("delivers each tile even when headers and PNG data cross network chunks", async () => {
    const first = encodeTileFrame(3, Uint8Array.from([1, 2, 3]));
    const second = encodeTileFrame(0, Uint8Array.from([4, 5]));
    const data = new Uint8Array(first.length + second.length);
    data.set(first);
    data.set(second, first.length);
    const received: Array<{ index: number; bytes: number[] }> = [];

    for await (const frame of readTileFrames(chunkedStream(data, [2, 3, 5, 1, 4]))) {
      received.push({ index: frame.index, bytes: [...frame.png] });
    }

    expect(received).toEqual([
      { index: 3, bytes: [1, 2, 3] },
      { index: 0, bytes: [4, 5] },
    ]);
  });

  it("surfaces a generation error from the server", async () => {
    const frame = encodeTileFrame(ERROR_TILE_INDEX, new TextEncoder().encode("Source image unavailable"));
    const read = async () => {
      for await (const _tile of readTileFrames(chunkedStream(frame, [4, 2]))) { /* read all frames */ }
    };
    await expect(read()).rejects.toThrow("Source image unavailable");
  });
});
