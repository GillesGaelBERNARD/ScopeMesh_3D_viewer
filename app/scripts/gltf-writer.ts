import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PrimitiveGeometry } from "./obj-parser.ts";

interface TextureBinding {
  materialName: string;
  lowFileName: string;
}

interface BufferView {
  buffer: number;
  byteOffset: number;
  byteLength: number;
  target?: number;
}

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: "SCALAR" | "VEC2" | "VEC3";
  min?: number[];
  max?: number[];
}

export async function writeGltf(
  outputDirectory: string,
  primitives: PrimitiveGeometry[],
  textureBindings: TextureBinding[],
): Promise<void> {
  const chunks: Buffer[] = [];
  const bufferViews: BufferView[] = [];
  const accessors: Accessor[] = [];
  let byteLength = 0;

  const append = (array: Float32Array | Uint16Array | Uint32Array, target: number): number => {
    const padding = (4 - (byteLength % 4)) % 4;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      byteLength += padding;
    }
    const data = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    const viewIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.byteLength, target });
    chunks.push(data);
    byteLength += data.byteLength;
    return viewIndex;
  };

  const addAccessor = (view: number, componentType: number, count: number, type: Accessor["type"], min?: number[], max?: number[]): number => {
    const index = accessors.length;
    accessors.push({ bufferView: view, componentType, count, type, min, max });
    return index;
  };

  const bindingByMaterial = new Map(textureBindings.map((binding, index) => [binding.materialName, { ...binding, index }]));
  const gltfPrimitives = primitives.map((primitive) => {
    const positions = new Float32Array(primitive.positions);
    const normals = new Float32Array(primitive.normals);
    const uvs = new Float32Array(primitive.uvs);
    const vertexCount = positions.length / 3;
    const indices = vertexCount > 65_535 ? new Uint32Array(primitive.indices) : new Uint16Array(primitive.indices);
    const positionAccessor = addAccessor(
      append(positions, 34962),
      5126,
      vertexCount,
      "VEC3",
      [...primitive.bounds.min],
      [...primitive.bounds.max],
    );
    const normalAccessor = addAccessor(append(normals, 34962), 5126, vertexCount, "VEC3");
    const uvAccessor = addAccessor(append(uvs, 34962), 5126, vertexCount, "VEC2");
    const indexAccessor = addAccessor(
      append(indices, 34963),
      indices instanceof Uint32Array ? 5125 : 5123,
      indices.length,
      "SCALAR",
    );
    return {
      attributes: { POSITION: positionAccessor, NORMAL: normalAccessor, TEXCOORD_0: uvAccessor },
      indices: indexAccessor,
      material: bindingByMaterial.get(primitive.materialName)?.index ?? 0,
      mode: 4,
    };
  });

  const gltf = {
    asset: { version: "2.0", generator: "ScopeMesh 3D viewer preparer" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Reef" }],
    meshes: [{ name: "Reef", primitives: gltfPrimitives }],
    buffers: [{ uri: "model.bin", byteLength }],
    bufferViews,
    accessors,
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    images: textureBindings.map((binding) => ({ uri: `low/${binding.lowFileName}` })),
    textures: textureBindings.map((_binding, index) => ({ sampler: 0, source: index })),
    materials: textureBindings.map((binding, index) => ({
      name: binding.materialName,
      pbrMetallicRoughness: {
        baseColorTexture: { index },
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      doubleSided: true,
    })),
  };

  await Promise.all([
    writeFile(join(outputDirectory, "model.bin"), Buffer.concat(chunks, byteLength)),
    writeFile(join(outputDirectory, "model.gltf"), `${JSON.stringify(gltf)}\n`, "utf8"),
  ]);
  console.log(`Wrote ${basename(outputDirectory)}/model.gltf (${(byteLength / 1024 / 1024).toFixed(1)} MiB geometry)`);
}
