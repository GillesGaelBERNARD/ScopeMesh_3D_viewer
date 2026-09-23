export interface DetailCacheStatus {
  usedBytes: number;
  limitBytes: number;
  pendingRemoval: number;
  datasets: Array<{ id: string; bytes: number; tiles: number }>;
}

export async function readDetailCacheResponse(response: Response): Promise<DetailCacheStatus> {
  if (!response.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
    throw new Error("Restart ScopeMesh 3D viewer to enable cache controls.");
  }
  const result = await response.json() as DetailCacheStatus & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Detail cache request failed (${response.status})`);
  return result;
}
