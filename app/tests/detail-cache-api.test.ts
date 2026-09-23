import { describe, expect, it } from "vitest";
import { readDetailCacheResponse } from "../src/detail-cache-api.ts";

describe("detail cache API response", () => {
  it("explains that the server needs restarting when an old server serves the app HTML", async () => {
    const response = new Response("<!doctype html><html></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });

    await expect(readDetailCacheResponse(response)).rejects.toThrow("Restart ScopeMesh 3D viewer to enable cache controls.");
  });

  it("accepts cache status JSON", async () => {
    const status = { usedBytes: 1, limitBytes: 2, pendingRemoval: 0, datasets: [] };
    const response = new Response(JSON.stringify(status), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });

    await expect(readDetailCacheResponse(response)).resolves.toEqual(status);
  });
});
