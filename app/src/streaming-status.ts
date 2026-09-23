import type { DetailOverlayStatus } from "./detail-tile-overlay.ts";
import type { StreamingStatus } from "./texture-streamer.ts";

export interface StreamingStatusPresentation {
  message: string;
  busy: boolean;
}

function completeDetail(status: DetailOverlayStatus | undefined): boolean {
  return status?.phase === "ready"
    && status.requestedTiles > 0
    && status.loadedTiles === status.requestedTiles
    && status.coverage >= 0.999;
}

export function streamingStatusPresentation(
  streaming: StreamingStatus | undefined,
  detail: DetailOverlayStatus | undefined,
): StreamingStatusPresentation {
  if (completeDetail(detail)) {
    return {
      message: detail?.source === "automatic"
        ? "Visible detail · full source resolution loaded"
        : "Selected area · full source resolution loaded",
      busy: false,
    };
  }
  if (detail?.phase === "analyzing" || detail?.phase === "loading") {
    return { message: "Loading source-resolution detail", busy: true };
  }
  if ((streaming?.loading ?? 0) > 0) {
    const loading = streaming?.loading ?? 0;
    return { message: `Streaming ${loading} texture${loading === 1 ? "" : "s"}`, busy: true };
  }
  if (streaming?.sourceResolutionComplete) {
    return { message: "Full source resolution loaded", busy: false };
  }
  return { message: streaming ? "Detail stream ready" : "Starting…", busy: false };
}
