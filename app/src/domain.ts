export type Vec3Tuple = [number, number, number];
export type TextureTier = "low" | "medium" | "full";
export type QualityMode = "auto" | "overview" | "detail";

export interface Bounds {
  min: Vec3Tuple;
  max: Vec3Tuple;
}

export interface TextureTierAsset {
  url: string;
  width: number;
  height: number;
  estimatedGpuBytes: number;
}

export interface MaterialAsset {
  name: string;
  bounds: Bounds;
  low: TextureTierAsset;
  medium: TextureTierAsset;
  full: TextureTierAsset;
}

export interface DatasetManifest {
  schemaVersion: 1;
  id: string;
  label: string;
  createdAt: string;
  modelUrl: string;
  upAxis: "Z";
  bounds: Bounds;
  center: Vec3Tuple;
  extent: Vec3Tuple;
  stats: {
    sourceVertices: number;
    renderedVertices: number;
    triangles: number;
    materials: number;
    sourceTextureBytes: number;
    fullDecodedTextureBytes: number;
  };
  materials: MaterialAsset[];
}

export interface PrivateDatasetConfig {
  sourceDirectory: string;
  hidden?: boolean;
}

export function estimateGpuBytes(width: number, height: number): number {
  // RGBA8 plus the complete mip chain (1 + 1/4 + 1/16 + ...).
  return Math.ceil(width * height * 4 * (4 / 3));
}
