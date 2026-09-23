import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import sharp from "sharp";
import { estimateGpuBytes, type DatasetManifest, type MaterialAsset, type PrivateDatasetConfig } from "../src/domain.ts";
import { writeGltf } from "./gltf-writer.ts";
import { findObjMaterialLibrary, parseMtl, parseObj } from "./obj-parser.ts";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "reef";
}

function tierDimensions(width: number, height: number, maximum: number): [number, number] {
  const scale = Math.min(1, maximum / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((value) => !value.startsWith("--"));
  const inputArgument = argument("input") ?? positional[0];
  const input = resolve(inputArgument ?? "");
  if (!inputArgument || extname(input).toLowerCase() !== ".obj") {
    throw new Error('Usage: npm run prepare-model -- "C:\\path\\model.obj" [id] ["Dataset label"]');
  }
  await stat(input);
  const id = slug(argument("id") ?? positional[1] ?? basename(input, extname(input)));
  const label = argument("label") ?? positional[2] ?? id.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const sourceDirectory = dirname(input);
  const outputDirectory = resolve(argument("output") ?? join("datasets", id));
  const materialLibrary = await findObjMaterialLibrary(input);
  if (!materialLibrary) throw new Error("OBJ does not reference an MTL file");
  const mtlPath = join(sourceDirectory, materialLibrary);

  console.log(`Parsing ${input}`);
  const materialDefinitions = await parseMtl(mtlPath);
  const parsed = await parseObj(input);
  await Promise.all([
    mkdir(join(outputDirectory, "low"), { recursive: true }),
    mkdir(join(outputDirectory, "medium"), { recursive: true }),
  ]);

  sharp.concurrency(2);
  const materialAssets: MaterialAsset[] = [];
  const textureBindings: { materialName: string; lowFileName: string }[] = [];
  let sourceTextureBytes = 0;
  let fullDecodedTextureBytes = 0;

  for (let index = 0; index < parsed.primitives.length; index += 1) {
    const primitive = parsed.primitives[index]!;
    const definition = materialDefinitions.get(primitive.materialName);
    if (!definition?.diffuseMap) throw new Error(`Material ${primitive.materialName} has no map_Kd texture`);
    const sourceFile = join(sourceDirectory, definition.diffuseMap);
    let sourceInfo;
    let metadata;
    try {
      sourceInfo = await stat(sourceFile);
      metadata = await sharp(sourceFile, { limitInputPixels: false, sequentialRead: true }).metadata();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read texture "${definition.diffuseMap}": ${reason}`);
    }
    if (!metadata.width || !metadata.height) throw new Error(`Cannot determine texture dimensions: ${sourceFile}`);
    const stem = `material-${String(index).padStart(3, "0")}`;
    const lowFileName = `${stem}.jpg`;
    const mediumFileName = `${stem}.jpg`;
    const lowPath = join(outputDirectory, "low", lowFileName);
    const mediumPath = join(outputDirectory, "medium", mediumFileName);
    const [lowWidth, lowHeight] = tierDimensions(metadata.width, metadata.height, 512);
    const [mediumWidth, mediumHeight] = tierDimensions(metadata.width, metadata.height, 2048);

    try {
      // Decode the source once. This matters for giant photogrammetry atlases: the
      // lightweight overview can be derived from the already-small medium tier.
      await sharp(sourceFile, { limitInputPixels: false, sequentialRead: true })
        .resize({ width: mediumWidth, height: mediumHeight, fit: "fill", kernel: "lanczos3" })
        .jpeg({ quality: 88, mozjpeg: true })
        .toFile(mediumPath);
      await sharp(mediumPath)
        .resize({ width: lowWidth, height: lowHeight, fit: "fill", kernel: "lanczos3" })
        .jpeg({ quality: 80, mozjpeg: true })
        .toFile(lowPath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot optimize texture "${definition.diffuseMap}": ${reason}`);
    }

    sourceTextureBytes += sourceInfo.size;
    fullDecodedTextureBytes += metadata.width * metadata.height * 4;
    const encodedSourceName = definition.diffuseMap.split(/[\\/]/).map(encodeURIComponent).join("/");
    materialAssets.push({
      name: primitive.materialName,
      bounds: primitive.bounds,
      low: { url: `/dataset/${id}/low/${lowFileName}`, width: lowWidth, height: lowHeight, estimatedGpuBytes: estimateGpuBytes(lowWidth, lowHeight) },
      medium: { url: `/dataset/${id}/medium/${mediumFileName}`, width: mediumWidth, height: mediumHeight, estimatedGpuBytes: estimateGpuBytes(mediumWidth, mediumHeight) },
      full: { url: `/source/${id}/${encodedSourceName}`, width: metadata.width, height: metadata.height, estimatedGpuBytes: estimateGpuBytes(metadata.width, metadata.height) },
    });
    textureBindings.push({ materialName: primitive.materialName, lowFileName });
    console.log(`[${index + 1}/${parsed.primitives.length}] ${primitive.materialName}: ${metadata.width}x${metadata.height} -> 512 / 2048`);
  }

  await writeGltf(outputDirectory, parsed.primitives, textureBindings);
  const center = parsed.bounds.min.map((value, axis) => (value + parsed.bounds.max[axis]!) / 2) as [number, number, number];
  const extent = parsed.bounds.min.map((value, axis) => parsed.bounds.max[axis]! - value) as [number, number, number];
  const manifest: DatasetManifest = {
    schemaVersion: 1,
    id,
    label,
    createdAt: new Date().toISOString(),
    modelUrl: `/dataset/${id}/model.gltf`,
    upAxis: "Z",
    bounds: parsed.bounds,
    center,
    extent,
    stats: {
      sourceVertices: parsed.sourceVertexCount,
      renderedVertices: parsed.renderedVertexCount,
      triangles: parsed.triangleCount,
      materials: materialAssets.length,
      sourceTextureBytes,
      fullDecodedTextureBytes,
    },
    materials: materialAssets,
  };
  const privateConfig: PrivateDatasetConfig = { sourceDirectory };
  await Promise.all([
    writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(join(outputDirectory, "dataset.private.json"), `${JSON.stringify(privateConfig, null, 2)}\n`, "utf8"),
  ]);
  console.log(`Prepared ${label}: ${parsed.triangleCount.toLocaleString()} triangles, ${materialAssets.length} streamed materials.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
