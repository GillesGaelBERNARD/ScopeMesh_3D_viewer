import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

const GiB = 1024 ** 3;
export const DEFAULT_DETAIL_CACHE_GIB = 2;
export const DETAIL_CACHE_LIMITS_GIB = Array.from({ length: 20 }, (_, index) => (index + 1) / 2);

interface CachedTile {
  datasetId: string;
  bytes: number;
  lastUsed: number;
}

export interface DetailCacheStatus {
  usedBytes: number;
  limitBytes: number;
  pendingRemoval: number;
  datasets: Array<{ id: string; bytes: number; tiles: number }>;
}

async function listPngFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listPngFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".png")) files.push(path);
  }
  return files;
}

export class DetailTileCache {
  private readonly tiles = new Map<string, CachedTile>();
  private readonly inUse = new Map<string, number>();
  private readonly pendingRemoval = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private limitBytes: number;

  constructor(private readonly datasetsRoot: string, defaultLimitBytes = DEFAULT_DETAIL_CACHE_GIB * GiB) {
    this.limitBytes = defaultLimitBytes;
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action, action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async initialize(): Promise<void> {
    await this.run(async () => {
      try {
        const settings = JSON.parse(await readFile(join(this.datasetsRoot, ".detail-cache-settings.json"), "utf8")) as { limitGiB?: number };
        if (DETAIL_CACHE_LIMITS_GIB.some((value) => value === settings.limitGiB)) this.limitBytes = settings.limitGiB! * GiB;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      let entries: Dirent[];
      try {
        entries = await readdir(this.datasetsRoot, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        for (const path of await listPngFiles(join(this.datasetsRoot, entry.name, "detail-tiles"))) {
          const info = await stat(path);
          this.tiles.set(path, { datasetId: entry.name, bytes: info.size, lastUsed: info.mtimeMs });
        }
      }
      await this.prune();
    });
  }

  async acquire(path: string): Promise<void> {
    await this.run(async () => {
      this.inUse.set(path, (this.inUse.get(path) ?? 0) + 1);
    });
  }

  async release(path: string): Promise<void> {
    await this.run(async () => {
      const count = this.inUse.get(path) ?? 0;
      if (count <= 1) this.inUse.delete(path);
      else this.inUse.set(path, count - 1);
      if (!this.inUse.has(path) && this.pendingRemoval.delete(path)) await this.remove(path);
      await this.prune();
    });
  }

  async record(datasetId: string, path: string): Promise<void> {
    const info = await stat(path);
    await this.run(async () => {
      this.tiles.set(path, { datasetId, bytes: info.size, lastUsed: Date.now() });
      await this.prune();
    });
  }

  async touch(path: string): Promise<void> {
    await this.run(async () => {
      const tile = this.tiles.get(path);
      if (!tile) return;
      const now = Date.now();
      const shouldPersist = now - tile.lastUsed > 60_000;
      tile.lastUsed = now;
      if (shouldPersist) {
        try { await utimes(path, new Date(now), new Date(now)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    });
  }

  async setLimitGiB(value: number): Promise<DetailCacheStatus> {
    if (!DETAIL_CACHE_LIMITS_GIB.some((allowed) => allowed === value)) throw new Error("Unsupported detail cache limit.");
    return this.run(async () => {
      await mkdir(this.datasetsRoot, { recursive: true });
      await writeFile(join(this.datasetsRoot, ".detail-cache-settings.json"), JSON.stringify({ limitGiB: value }));
      this.limitBytes = value * GiB;
      await this.prune();
      return this.snapshot();
    });
  }

  async clear(datasetId?: string): Promise<DetailCacheStatus> {
    return this.run(async () => {
      for (const [path, tile] of this.tiles) {
        if (datasetId && tile.datasetId !== datasetId) continue;
        if (this.inUse.has(path)) this.pendingRemoval.add(path);
        else await this.remove(path);
      }
      return this.snapshot();
    });
  }

  async status(): Promise<DetailCacheStatus> {
    return this.run(async () => this.snapshot());
  }

  private snapshot(): DetailCacheStatus {
    const datasets = new Map<string, { id: string; bytes: number; tiles: number }>();
    let usedBytes = 0;
    for (const tile of this.tiles.values()) {
      usedBytes += tile.bytes;
      const group = datasets.get(tile.datasetId) ?? { id: tile.datasetId, bytes: 0, tiles: 0 };
      group.bytes += tile.bytes;
      group.tiles += 1;
      datasets.set(tile.datasetId, group);
    }
    return {
      usedBytes,
      limitBytes: this.limitBytes,
      pendingRemoval: this.pendingRemoval.size,
      datasets: [...datasets.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  private async remove(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.tiles.delete(path);
  }

  private async prune(): Promise<void> {
    let excess = this.snapshot().usedBytes - this.limitBytes;
    if (excess <= 0) return;
    const candidates = [...this.tiles]
      .filter(([path]) => !this.inUse.has(path))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [path, tile] of candidates) {
      if (excess <= 0) break;
      await this.remove(path);
      excess -= tile.bytes;
    }
  }
}
