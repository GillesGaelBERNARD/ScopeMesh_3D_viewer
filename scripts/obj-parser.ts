import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Bounds, Vec3Tuple } from "../src/domain.ts";

export interface MaterialDefinition {
  name: string;
  diffuseMap?: string;
}

export interface PrimitiveGeometry {
  materialName: string;
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  bounds: Bounds;
}

export interface ParsedObj {
  primitives: PrimitiveGeometry[];
  bounds: Bounds;
  sourceVertexCount: number;
  renderedVertexCount: number;
  triangleCount: number;
}

interface PrimitiveBuilder extends PrimitiveGeometry {
  vertexMap: Map<string, number>;
}

function emptyBounds(): Bounds {
  return {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  };
}

function includePoint(bounds: Bounds, point: Vec3Tuple): void {
  bounds.min[0] = Math.min(bounds.min[0], point[0]);
  bounds.min[1] = Math.min(bounds.min[1], point[1]);
  bounds.min[2] = Math.min(bounds.min[2], point[2]);
  bounds.max[0] = Math.max(bounds.max[0], point[0]);
  bounds.max[1] = Math.max(bounds.max[1], point[1]);
  bounds.max[2] = Math.max(bounds.max[2], point[2]);
}

function resolveIndex(raw: string | undefined, length: number): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value === 0) return undefined;
  return value > 0 ? value - 1 : length + value;
}

export async function findObjMaterialLibrary(path: string): Promise<string | undefined> {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith("mtllib ")) return line.slice(7).trim();
    }
    return undefined;
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function parseMtl(path: string): Promise<Map<string, MaterialDefinition>> {
  const text = await readFile(path, "utf8");
  const materials = new Map<string, MaterialDefinition>();
  let current: MaterialDefinition | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("newmtl ")) {
      current = { name: line.slice(7).trim() };
      materials.set(current.name, current);
    } else if (current && line.startsWith("map_Kd ")) {
      current.diffuseMap = line.slice(7).trim().replace(/^"|"$/g, "");
    }
  }
  return materials;
}

export async function parseObj(path: string): Promise<ParsedObj> {
  const sourcePositions: Vec3Tuple[] = [];
  const sourceNormals: Vec3Tuple[] = [];
  const sourceUvs: [number, number][] = [];
  const builders = new Map<string, PrimitiveBuilder>();
  const overallBounds = emptyBounds();
  let currentMaterial = "default";
  let triangleCount = 0;

  const getBuilder = (name: string): PrimitiveBuilder => {
    let builder = builders.get(name);
    if (!builder) {
      builder = {
        materialName: name,
        positions: [],
        normals: [],
        uvs: [],
        indices: [],
        bounds: emptyBounds(),
        vertexMap: new Map(),
      };
      builders.set(name, builder);
    }
    return builder;
  };

  const addCorner = (builder: PrimitiveBuilder, token: string): number => {
    const existing = builder.vertexMap.get(token);
    if (existing !== undefined) return existing;
    const [positionRaw, uvRaw, normalRaw] = token.split("/");
    const positionIndex = resolveIndex(positionRaw, sourcePositions.length);
    if (positionIndex === undefined || !sourcePositions[positionIndex]) {
      throw new Error(`Invalid OBJ position index: ${token}`);
    }
    const point = sourcePositions[positionIndex];
    const uvIndex = resolveIndex(uvRaw, sourceUvs.length);
    const normalIndex = resolveIndex(normalRaw, sourceNormals.length);
    const uv: [number, number] = uvIndex === undefined ? [0, 0] : sourceUvs[uvIndex] ?? [0, 0];
    const normal: Vec3Tuple = normalIndex === undefined ? [0, 0, 1] : sourceNormals[normalIndex] ?? [0, 0, 1];
    const index = builder.positions.length / 3;
    builder.positions.push(...point);
    builder.normals.push(...normal);
    // Wavefront V has its origin at the bottom; glTF image coordinates start at the top.
    builder.uvs.push(uv[0], 1 - uv[1]);
    includePoint(builder.bounds, point);
    builder.vertexMap.set(token, index);
    return index;
  };

  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("v ")) {
      const values = line.split(/\s+/).slice(1, 4).map(Number);
      const point: Vec3Tuple = [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
      sourcePositions.push(point);
      includePoint(overallBounds, point);
    } else if (line.startsWith("vn ")) {
      const values = line.split(/\s+/).slice(1, 4).map(Number);
      sourceNormals.push([values[0] ?? 0, values[1] ?? 0, values[2] ?? 1]);
    } else if (line.startsWith("vt ")) {
      const values = line.split(/\s+/).slice(1, 3).map(Number);
      sourceUvs.push([values[0] ?? 0, values[1] ?? 0]);
    } else if (line.startsWith("usemtl ")) {
      currentMaterial = line.slice(7).trim();
    } else if (line.startsWith("f ")) {
      const corners = line.split(/\s+/).slice(1);
      if (corners.length < 3) continue;
      const builder = getBuilder(currentMaterial);
      for (let i = 1; i < corners.length - 1; i += 1) {
        builder.indices.push(
          addCorner(builder, corners[0]!),
          addCorner(builder, corners[i]!),
          addCorner(builder, corners[i + 1]!),
        );
        triangleCount += 1;
      }
    }
  }

  const primitives = [...builders.values()].map(({ vertexMap: _vertexMap, ...primitive }) => primitive);
  return {
    primitives,
    bounds: overallBounds,
    sourceVertexCount: sourcePositions.length,
    renderedVertexCount: primitives.reduce((sum, primitive) => sum + primitive.positions.length / 3, 0),
    triangleCount,
  };
}
