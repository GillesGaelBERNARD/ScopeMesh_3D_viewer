import express from "express";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { DetailTileCache } from "./detail-cache.ts";
import { DETAIL_BAND_HEIGHT, generateTileBand, type BandTile } from "./detail-tile-batch.ts";
import { encodeTileFrame, ERROR_TILE_INDEX } from "./src/detail-tile-stream.ts";
import { DETAIL_TILE_GUTTER, DETAIL_TILE_SIZE, MAX_DETAIL_TILE_SIZE } from "./src/detail-tiles.ts";
import type { DatasetManifest, PrivateDatasetConfig } from "./src/domain.ts";
import { concisePreparationError } from "./src/preparation-error.ts";

const root = dirname(fileURLToPath(import.meta.url));
const datasetsRoot = join(root, "datasets");
const isDevelopment = process.argv.includes("--dev");
const port = Number(process.env.PORT ?? 4173);

interface DatasetRecord {
  config: PrivateDatasetConfig;
  label: string;
  manifest: DatasetManifest;
}

interface PreparationJob {
  id: string;
  datasetId: string;
  label: string;
  status: "queued" | "running" | "complete" | "failed";
  progress: number;
  message: string;
}

async function loadDatasetRecord(id: string): Promise<DatasetRecord> {
  const [config, manifest] = await Promise.all([
    readFile(join(datasetsRoot, id, "dataset.private.json"), "utf8").then((text) => JSON.parse(text) as PrivateDatasetConfig),
    readFile(join(datasetsRoot, id, "manifest.json"), "utf8").then((text) => JSON.parse(text) as DatasetManifest),
  ]);
  return { config, label: manifest.label, manifest };
}

async function discoverDatasets(): Promise<Map<string, DatasetRecord>> {
  const result = new Map<string, DatasetRecord>();
  let entries: string[] = [];
  try {
    entries = await readdir(datasetsRoot);
  } catch {
    return result;
  }
  for (const id of entries) {
    try {
      const record = await loadDatasetRecord(id);
      if (!record.config.hidden) result.set(id, record);
    } catch {
      // Ignore incomplete dataset directories.
    }
  }
  return result;
}

const datasets = await discoverDatasets();
const jobs = new Map<string, PreparationJob>();
const detailTileJobs = new Map<string, Promise<string>>();
let detailBandQueue: Promise<unknown> = Promise.resolve();
const detailTileCache = new DetailTileCache(datasetsRoot);
await detailTileCache.initialize();
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/api/datasets", (_request, response) => {
  response.json([...datasets].map(([id, record]) => ({ id, label: record.label })));
});

app.get("/api/detail-cache", async (_request, response) => {
  try {
    response.json(await detailTileCache.status());
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Could not read detail cache." });
  }
});

app.put("/api/detail-cache/settings", async (request, response) => {
  try {
    response.json(await detailTileCache.setLimitGiB(request.body?.limitGiB));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "Could not set detail cache limit." });
  }
});

app.delete("/api/detail-cache", async (_request, response) => {
  try {
    response.json(await detailTileCache.clear());
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Could not clear detail cache." });
  }
});

app.delete("/api/detail-cache/:id", async (request, response) => {
  if (!datasets.has(request.params.id)) return response.status(404).json({ error: "Dataset not found." });
  try {
    response.json(await detailTileCache.clear(request.params.id));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : "Could not clear detail cache." });
  }
});

app.post("/api/pick-model", (_request, response) => {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    "$dialog.Filter = 'Wavefront OBJ (*.obj)|*.obj'",
    "$dialog.Title = 'Choose a textured photogrammetry OBJ'",
    "$dialog.CheckFileExists = $true",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }",
  ].join("; ");
  execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: true }, (error, stdout) => {
    if (error) return response.status(500).json({ error: "The Windows file picker could not be opened." });
    response.json({ path: stdout.trim() || null });
  });
});

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "reef";
}

async function uniqueDatasetId(preferred: string): Promise<string> {
  const base = slug(preferred);
  let candidate = base;
  let suffix = 2;
  while (true) {
    try {
      await access(join(datasetsRoot, candidate));
      candidate = `${base}-${suffix}`;
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}

app.post("/api/prepare", async (request, response) => {
  const modelPath = typeof request.body?.path === "string" ? resolve(request.body.path.trim()) : "";
  const suppliedLabel = typeof request.body?.label === "string" ? request.body.label.trim() : "";
  if (!modelPath || extname(modelPath).toLowerCase() !== ".obj") {
    return response.status(400).json({ error: "Choose a Wavefront .obj model." });
  }
  try {
    if (!(await stat(modelPath)).isFile()) throw new Error("not a file");
  } catch {
    return response.status(400).json({ error: "The OBJ file could not be found." });
  }
  const label = suppliedLabel || basename(modelPath, extname(modelPath)).replace(/[_-]+/g, " ");
  const datasetId = await uniqueDatasetId(label);
  const job: PreparationJob = {
    id: randomUUID(), datasetId, label, status: "queued", progress: 0,
    message: "Waiting to start…",
  };
  jobs.set(job.id, job);
  response.status(202).json(job);

  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [
    tsxCli,
    join(root, "scripts", "prepare.ts"),
    `--input=${modelPath}`,
    `--id=${datasetId}`,
    `--label=${label}`,
  ], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  job.status = "running";
  job.progress = 2;
  job.message = "Reading mesh geometry and materials…";

  const handleOutput = (chunk: Buffer): void => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      const textureProgress = line.match(/^\[(\d+)\/(\d+)\]/);
      if (textureProgress) {
        const completed = Number(textureProgress[1]);
        const total = Number(textureProgress[2]);
        job.progress = Math.round(5 + (completed / total) * 90);
        job.message = `Optimizing texture ${completed} of ${total}…`;
      } else if (line.startsWith("Wrote ")) {
        job.progress = 97;
        job.message = "Writing the compact mesh…";
      }
    }
  };
  child.stdout.on("data", handleOutput);
  let errorOutput = "";
  child.stderr.on("data", (chunk: Buffer) => { errorOutput += chunk.toString(); });
  child.on("error", (error) => {
    job.status = "failed";
    job.message = error.message;
  });
  child.on("close", async (code) => {
    if (code === 0) {
      try {
        datasets.set(datasetId, await loadDatasetRecord(datasetId));
        job.status = "complete";
        job.progress = 100;
        job.message = "Model ready to open.";
      } catch (error) {
        job.status = "failed";
        job.message = error instanceof Error ? error.message : "The generated dataset could not be registered.";
      }
    } else if (job.status !== "failed") {
      job.status = "failed";
      job.message = concisePreparationError(errorOutput, code);
    }
  });
});

app.get("/api/jobs/:id", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).json({ error: "Conversion job not found." });
  response.json(job);
});

function sourceTexturePath(id: string, record: DatasetRecord, materialIndex: number): string {
  const material = record.manifest.materials[materialIndex];
  if (!material) throw new Error("Texture material not found.");
  const prefix = `/source/${id}/`;
  if (!material.full.url.startsWith(prefix)) throw new Error("Texture source is not local.");
  const segments = material.full.url.slice(prefix.length).split("/").map(decodeURIComponent);
  const sourceRoot = resolve(record.config.sourceDirectory);
  const sourcePath = resolve(sourceRoot, ...segments);
  if (sourcePath !== sourceRoot && !sourcePath.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error("Texture source is outside the dataset folder.");
  }
  return sourcePath;
}

function detailTilePath(id: string, materialIndex: number, tileSize: number, x: number, y: number): string {
  return join(datasetsRoot, id, "detail-tiles", String(tileSize), String(materialIndex).padStart(3, "0"), `${x}-${y}.png`);
}

function detailTileKey(id: string, materialIndex: number, tileSize: number, x: number, y: number): string {
  return `${id}:${materialIndex}:${tileSize}:${x}:${y}`;
}

interface BatchTile extends BandTile {
  materialIndex: number;
  size: number;
  x: number;
  y: number;
  bandIndex: number;
  path: string;
  key: string;
}

function parseBatchTiles(id: string, record: DatasetRecord, input: unknown): BatchTile[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 8000) throw new Error("Choose between 1 and 8000 detail tiles.");
  const seen = new Set<string>();
  return input.map((value: unknown, index) => {
    if (!value || typeof value !== "object") throw new Error("Invalid detail tile request.");
    const candidate = value as { materialIndex?: unknown; size?: unknown; x?: unknown; y?: unknown };
    const { materialIndex, size, x, y } = candidate;
    if (![materialIndex, size, x, y].every(Number.isInteger)) throw new Error("Invalid detail tile coordinates.");
    const materialNumber = materialIndex as number;
    const tileSize = size as number;
    const tileX = x as number;
    const tileY = y as number;
    const material = record.manifest.materials[materialNumber];
    if (!material || tileSize < DETAIL_TILE_SIZE || tileSize > MAX_DETAIL_TILE_SIZE || (tileSize & (tileSize - 1)) !== 0 ||
      tileX < 0 || tileY < 0 || tileX >= Math.ceil(material.full.width / tileSize) || tileY >= Math.ceil(material.full.height / tileSize)) {
      throw new Error("Detail tile is outside the source image.");
    }
    const key = detailTileKey(id, materialNumber, tileSize, tileX, tileY);
    if (seen.has(key)) throw new Error("Duplicate detail tile request.");
    seen.add(key);
    const coreLeft = tileX * tileSize;
    const coreTop = tileY * tileSize;
    const left = Math.max(0, coreLeft - DETAIL_TILE_GUTTER);
    const top = Math.max(0, coreTop - DETAIL_TILE_GUTTER);
    const right = Math.min(material.full.width, coreLeft + tileSize + DETAIL_TILE_GUTTER);
    const bottom = Math.min(material.full.height, coreTop + tileSize + DETAIL_TILE_GUTTER);
    return {
      index, materialIndex: materialNumber, size: tileSize, x: tileX, y: tileY,
      left, top, width: right - left, height: bottom - top,
      bandIndex: Math.floor(coreTop / DETAIL_BAND_HEIGHT),
      path: detailTilePath(id, materialNumber, tileSize, tileX, tileY), key,
    };
  });
}

async function runDetailBand(action: () => Promise<void>): Promise<void> {
  const result = detailBandQueue.then(action, action);
  detailBandQueue = result.catch(() => undefined);
  await result;
}

async function sendDetailFrame(response: express.Response, index: number, payload: Uint8Array): Promise<void> {
  if (response.destroyed) throw new Error("Detail request closed.");
  const frame = Buffer.from(encodeTileFrame(index, payload));
  await new Promise<void>((resolve, reject) => {
    const closed = (): void => reject(new Error("Detail request closed."));
    response.once("close", closed);
    response.write(frame, (error) => {
      response.off("close", closed);
      if (error) reject(error);
      else resolve();
    });
  });
}

async function sendCachedTile(response: express.Response, tile: BatchTile, path = tile.path): Promise<void> {
  await detailTileCache.acquire(path);
  try {
    const png = await readFile(path);
    await detailTileCache.touch(path);
    await sendDetailFrame(response, tile.index, png);
  } finally {
    await detailTileCache.release(path);
  }
}

async function saveGeneratedTile(id: string, tile: BatchTile, png: Buffer): Promise<void> {
  await mkdir(dirname(tile.path), { recursive: true });
  const temporaryPath = `${tile.path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, png);
    await rename(temporaryPath, tile.path);
    await detailTileCache.record(id, tile.path);
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function tileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function createDetailTile(id: string, record: DatasetRecord, materialIndex: number, tileSize: number, x: number, y: number): Promise<string> {
  const material = record.manifest.materials[materialIndex];
  if (!material) throw new Error("Texture material not found.");
  if (tileSize < DETAIL_TILE_SIZE || tileSize > MAX_DETAIL_TILE_SIZE || (tileSize & (tileSize - 1)) !== 0) {
    throw new Error("Unsupported texture tile size.");
  }
  const columns = Math.ceil(material.full.width / tileSize);
  const rows = Math.ceil(material.full.height / tileSize);
  if (x < 0 || y < 0 || x >= columns || y >= rows) throw new Error("Texture tile is outside the source image.");
  const cachePath = detailTilePath(id, materialIndex, tileSize, x, y);
  try {
    await access(cachePath);
    return cachePath;
  } catch {
    // The tile is generated once and then served from the local cache.
  }
  const key = detailTileKey(id, materialIndex, tileSize, x, y);
  const existing = detailTileJobs.get(key);
  if (existing) return existing;
  const job = (async () => {
    const coreLeft = x * tileSize;
    const coreTop = y * tileSize;
    const coreRight = Math.min(material.full.width, coreLeft + tileSize);
    const coreBottom = Math.min(material.full.height, coreTop + tileSize);
    const left = Math.max(0, coreLeft - DETAIL_TILE_GUTTER);
    const top = Math.max(0, coreTop - DETAIL_TILE_GUTTER);
    const right = Math.min(material.full.width, coreRight + DETAIL_TILE_GUTTER);
    const bottom = Math.min(material.full.height, coreBottom + DETAIL_TILE_GUTTER);
    await mkdir(dirname(cachePath), { recursive: true });
    await sharp(sourceTexturePath(id, record, materialIndex), { limitInputPixels: false, sequentialRead: true })
      .extract({ left, top, width: right - left, height: bottom - top })
      .png({ compressionLevel: 6, adaptiveFiltering: true })
      .toFile(cachePath);
    await detailTileCache.record(id, cachePath);
    return cachePath;
  })();
  detailTileJobs.set(key, job);
  try {
    return await job;
  } finally {
    detailTileJobs.delete(key);
  }
}

app.get("/api/detail-tile/:id/:materialIndex/:tileSize/:x/:y", async (request, response) => {
  const record = datasets.get(request.params.id);
  if (!record) return response.status(404).json({ error: "Dataset not found." });
  const materialIndex = Number.parseInt(request.params.materialIndex, 10);
  const tileSize = Number.parseInt(request.params.tileSize, 10);
  const x = Number.parseInt(request.params.x, 10);
  const y = Number.parseInt(request.params.y, 10);
  if (![materialIndex, tileSize, x, y].every(Number.isInteger)) {
    return response.status(400).json({ error: "Invalid texture tile coordinates." });
  }
  const cachePath = detailTilePath(request.params.id, materialIndex, tileSize, x, y);
  await detailTileCache.acquire(cachePath);
  try {
    const path = await createDetailTile(request.params.id, record, materialIndex, tileSize, x, y);
    await detailTileCache.touch(path);
    response.setHeader("Cache-Control", "no-store");
    return response.type("image/png").sendFile(path, (error) => {
      void detailTileCache.release(path).catch(console.error);
      if (error) {
        if (response.headersSent) response.destroy(error);
        else response.status(500).json({ error: "Texture tile could not be sent." });
      }
    });
  } catch (error) {
    await detailTileCache.release(cachePath);
    return response.status(400).json({ error: error instanceof Error ? error.message : "Texture tile could not be generated." });
  }
});

app.post("/api/detail-tiles/:id/batch", async (request, response) => {
  const id = request.params.id;
  const record = datasets.get(id);
  if (!record) return response.status(404).json({ error: "Dataset not found." });
  let tiles: BatchTile[];
  try {
    tiles = parseBatchTiles(id, record, request.body?.tiles);
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : "Invalid detail tile request." });
  }

  let cancelled = false;
  response.on("close", () => { if (!response.writableEnded) cancelled = true; });
  response.setHeader("Content-Type", "application/x-reefstream-tiles");
  response.setHeader("Cache-Control", "no-store");
  response.flushHeaders();
  try {
    const groups = new Map<string, BatchTile[]>();
    for (const tile of tiles) {
      if (cancelled) return;
      if (await tileExists(tile.path)) {
        await sendCachedTile(response, tile);
      } else {
        const key = `${tile.materialIndex}:${tile.bandIndex}`;
        const group = groups.get(key) ?? [];
        group.push(tile);
        groups.set(key, group);
      }
    }

    const orderedGroups = [...groups.values()].sort((a, b) => a[0]!.index - b[0]!.index);
    for (const group of orderedGroups) {
      if (cancelled) return;
      const pending: BatchTile[] = [];
      for (const tile of group) {
        if (await tileExists(tile.path)) {
          await sendCachedTile(response, tile);
          continue;
        }
        const existing = detailTileJobs.get(tile.key);
        if (existing) {
          let completedPath: string | undefined;
          try {
            completedPath = await existing;
          } catch {
            if (cancelled) return;
          }
          if (completedPath) {
            await sendCachedTile(response, tile, completedPath);
            continue;
          }
        }
        pending.push(tile);
      }
      if (pending.length === 0) continue;
      if (pending.length === 1) {
        const tile = pending[0]!;
        await detailTileCache.acquire(tile.path);
        try {
          const path = await createDetailTile(id, record, tile.materialIndex, tile.size, tile.x, tile.y);
          const png = await readFile(path);
          await detailTileCache.touch(path);
          await sendDetailFrame(response, tile.index, png);
        } finally {
          await detailTileCache.release(tile.path);
        }
        continue;
      }

      const unresolved = new Map<string, (error: Error) => void>();
      const resolvers = new Map<string, (path: string) => void>();
      const batchJobs = new Map<string, Promise<string>>();
      const acquired = new Set<string>();
      try {
        for (const tile of pending) {
          let resolveJob!: (path: string) => void;
          let rejectJob!: (error: Error) => void;
          const job = new Promise<string>((resolve, reject) => { resolveJob = resolve; rejectJob = reject; });
          void job.catch(() => undefined);
          detailTileJobs.set(tile.key, job);
          batchJobs.set(tile.key, job);
          unresolved.set(tile.key, rejectJob);
          resolvers.set(tile.key, resolveJob);
          await detailTileCache.acquire(tile.path);
          acquired.add(tile.path);
        }
        const materialIndex = pending[0]!.materialIndex;
        const material = record.manifest.materials[materialIndex]!;
        const byIndex = new Map(pending.map((tile) => [tile.index, tile]));
        await runDetailBand(() => generateTileBand(
          sourceTexturePath(id, record, materialIndex), material.full.width, material.full.height,
          pending[0]!.bandIndex, pending,
          async (bandTile, png) => {
            if (cancelled) throw new Error("Detail request closed.");
            const tile = byIndex.get(bandTile.index)!;
            await saveGeneratedTile(id, tile, png);
            resolvers.get(tile.key)?.(tile.path);
            unresolved.delete(tile.key);
            if (detailTileJobs.get(tile.key) === batchJobs.get(tile.key)) detailTileJobs.delete(tile.key);
            await sendDetailFrame(response, tile.index, png);
            await detailTileCache.release(tile.path);
            acquired.delete(tile.path);
          },
          () => cancelled,
        ));
      } finally {
        for (const tile of pending) {
          unresolved.get(tile.key)?.(new Error("Detail batch was interrupted."));
          if (detailTileJobs.get(tile.key) === batchJobs.get(tile.key)) detailTileJobs.delete(tile.key);
          if (acquired.has(tile.path)) await detailTileCache.release(tile.path);
        }
      }
    }
    if (!cancelled) response.end();
  } catch (error) {
    if (cancelled || response.destroyed) return;
    const message = error instanceof Error ? error.message : "Detail tiles could not be generated.";
    try {
      await sendDetailFrame(response, ERROR_TILE_INDEX, Buffer.from(message));
      response.end();
    } catch {
      response.destroy();
    }
  }
});

app.use("/dataset", express.static(datasetsRoot, { fallthrough: false, maxAge: isDevelopment ? 0 : "1d" }));

app.use("/source", (request, response, next) => {
  const segments = request.path.split("/").filter(Boolean);
  const id = segments.shift();
  if (!id) return response.status(404).end();
  const record = datasets.get(id);
  if (!record) return response.status(404).end();
  const sourceRoot = resolve(record.config.sourceDirectory);
  const requested = resolve(sourceRoot, ...segments.map(decodeURIComponent));
  if (requested !== sourceRoot && !requested.startsWith(`${sourceRoot}${sep}`)) return response.status(403).end();
  response.setHeader("Cache-Control", "public, max-age=86400");
  response.sendFile(requested, (error) => {
    if (error) next(error);
  });
});

if (isDevelopment) {
  const { createServer } = await import("vite");
  const vite = await createServer({ root, server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  const dist = join(root, "dist");
  app.use(express.static(dist));
  app.get("/*path", (_request, response) => response.sendFile(join(dist, "index.html")));
}

app.listen(port, "127.0.0.1", () => {
  console.log(`ScopeMesh 3D viewer running at http://127.0.0.1:${port}`);
  console.log(`Datasets: ${[...datasets.keys()].join(", ") || "none (add a model in the app)"}`);
});
