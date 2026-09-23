import { afterEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DETAIL_CACHE_LIMITS_GIB, DetailTileCache } from "../detail-cache.ts";

const temporaryRoots: string[] = [];

async function temporaryDataset(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reefstream-cache-"));
  temporaryRoots.push(root);
  return root;
}

async function tile(root: string, datasetId: string, name: string, bytes: number, age: Date): Promise<string> {
  const directory = join(root, datasetId, "detail-tiles", "256", "000");
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, Buffer.alloc(bytes));
  await utimes(path, age, age);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generated detail tile disk cache", () => {
  it("supports half-GiB limits from 0.5 through 10 GiB", async () => {
    expect(DETAIL_CACHE_LIMITS_GIB).toEqual(Array.from({ length: 20 }, (_, index) => (index + 1) / 2));

    const root = await temporaryDataset();
    const cache = new DetailTileCache(root);
    await cache.initialize();
    await expect(cache.setLimitGiB(10)).resolves.toMatchObject({ limitBytes: 10 * 1024 ** 3 });
    await expect(cache.setLimitGiB(0.75)).rejects.toThrow("Unsupported detail cache limit.");
  });

  it("evicts the oldest generated tiles when the disk limit is reached", async () => {
    const root = await temporaryDataset();
    const old = await tile(root, "reef", "old.png", 6, new Date("2024-01-01"));
    const newest = await tile(root, "reef", "new.png", 6, new Date("2024-01-02"));
    const original = join(root, "reef", "model.gltf");
    await writeFile(original, "original model");

    const cache = new DetailTileCache(root, 10);
    await cache.initialize();

    expect((await cache.status()).usedBytes).toBe(6);
    await expect(access(old)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(newest)).resolves.toBeUndefined();
    expect(await readFile(original, "utf8")).toBe("original model");
  });

  it("clears one model while preserving tiles still being served until the request finishes", async () => {
    const root = await temporaryDataset();
    const active = await tile(root, "reef-a", "active.png", 4, new Date("2024-01-01"));
    const other = await tile(root, "reef-b", "other.png", 4, new Date("2024-01-01"));
    const cache = new DetailTileCache(root, 100);
    await cache.initialize();
    await cache.acquire(active);

    const clearing = await cache.clear("reef-a");
    expect(clearing.pendingRemoval).toBe(1);
    await expect(access(active)).resolves.toBeUndefined();
    await cache.release(active);

    expect((await cache.status()).usedBytes).toBe(4);
    await expect(access(active)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(other)).resolves.toBeUndefined();
  });

  it("makes room for a newly generated tile without deleting it mid-request", async () => {
    const root = await temporaryDataset();
    const older = await tile(root, "reef", "older.png", 6, new Date("2024-01-01"));
    const cache = new DetailTileCache(root, 10);
    await cache.initialize();
    const generated = join(root, "reef", "detail-tiles", "256", "000", "generated.png");
    await cache.acquire(generated);
    await writeFile(generated, Buffer.alloc(6));

    await cache.record("reef", generated);
    expect((await cache.status()).usedBytes).toBe(6);
    await expect(access(older)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(generated)).resolves.toBeUndefined();
    await cache.release(generated);
  });

  it("remembers the chosen cache limit across app restarts", async () => {
    const root = await temporaryDataset();
    const cache = new DetailTileCache(root);
    await cache.initialize();
    await cache.setLimitGiB(1);

    const restarted = new DetailTileCache(root);
    await restarted.initialize();

    expect((await restarted.status()).limitBytes).toBe(1024 ** 3);
  });
});
