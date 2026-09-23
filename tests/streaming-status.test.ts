import { describe, expect, it } from "vitest";
import type { DetailOverlayStatus } from "../src/detail-tile-overlay.ts";
import type { StreamingStatus } from "../src/texture-streamer.ts";
import { streamingStatusPresentation } from "../src/streaming-status.ts";

const textureReady: StreamingStatus = {
  loading: 0,
  fullCount: 2,
  mediumCount: 0,
  dynamicBytes: 100,
  sourceResolutionComplete: true,
};

function detailReady(source: "manual" | "automatic"): DetailOverlayStatus {
  return {
    phase: "ready",
    source,
    requestedTiles: 209,
    loadedTiles: 209,
    materialCount: 3,
    estimatedGpuBytes: 200,
    coverage: 1,
  };
}

describe("streamingStatusPresentation", () => {
  it("reacts when a mode switch finishes loading the whole model at source resolution", () => {
    expect(streamingStatusPresentation(textureReady, undefined)).toEqual({
      message: "Full source resolution loaded",
      busy: false,
    });
  });

  it("reports successful full-resolution loading for a drawn area", () => {
    expect(streamingStatusPresentation({ ...textureReady, sourceResolutionComplete: false }, detailReady("manual"))).toEqual({
      message: "Selected area · full source resolution loaded",
      busy: false,
    });
  });

  it("reports successful full-resolution loading for automatic visible detail", () => {
    expect(streamingStatusPresentation({ ...textureReady, sourceResolutionComplete: false }, detailReady("automatic"))).toEqual({
      message: "Visible detail · full source resolution loaded",
      busy: false,
    });
  });

  it("returns to the texture-streaming state after detail is cleared", () => {
    expect(streamingStatusPresentation({ ...textureReady, sourceResolutionComplete: false }, {
      ...detailReady("manual"),
      phase: "idle",
      requestedTiles: 0,
      loadedTiles: 0,
      coverage: 0,
    })).toEqual({ message: "Detail stream ready", busy: false });
  });
});
