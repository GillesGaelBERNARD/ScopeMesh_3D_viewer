import {
  Color,
  DoubleSide,
  GLSL3,
  Group,
  ImageBitmapLoader,
  LinearMipmapLinearFilter,
  Mesh,
  NearestFilter,
  NoBlending,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
  WebGLRenderer,
  WebGLRenderTarget,
  type Camera,
  type Material,
  MeshStandardMaterial,
} from "three";
import type { DatasetManifest } from "./domain.ts";
import { createDetailMaterial } from "./detail-material.ts";
import {
  collectPickedTiles,
  detailTileKey,
  planDetailTiles,
  reconcileDetailTiles,
  type DetailTilePlan,
  type PlannedDetailTile,
} from "./detail-tiles.ts";
import { readTileFrames } from "./detail-tile-stream.ts";
import type { ScreenRect } from "./rectangle-selection.ts";

export interface DetailOverlayStatus {
  phase: "idle" | "analyzing" | "loading" | "ready" | "limited" | "error";
  source?: DetailOverlaySource;
  requestedTiles: number;
  loadedTiles: number;
  materialCount: number;
  estimatedGpuBytes: number;
  coverage: number;
  message?: string;
}

export type DetailOverlaySource = "manual" | "automatic";

interface MaterialReplacement {
  mesh: Mesh;
  material: Material | Material[];
}

interface AttachedDetailTile {
  texture: Texture;
  material: Material;
  overlays: Mesh[];
}

const pickVertexShader = `
  precision highp float;
  in vec3 position;
  in vec2 uv;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  out vec2 sourceUv;
  void main() {
    sourceUv = fract(uv);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const pickFragmentShader = `
  precision highp float;
  uniform vec2 encodedId;
  in vec2 sourceUv;
  out vec4 outputColor;
  void main() {
    outputColor = vec4(sourceUv, encodedId);
  }
`;

const discardVertexShader = `
  void main() {
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const discardFragmentShader = `
  void main() { discard; }
`;

function selectionBounds(selection: ScreenRect, width: number, height: number): ScreenRect {
  return {
    left: Math.max(0, Math.min(width, Math.floor(selection.left))),
    top: Math.max(0, Math.min(height, Math.floor(selection.top))),
    right: Math.max(0, Math.min(width, Math.ceil(selection.right))),
    bottom: Math.max(0, Math.min(height, Math.ceil(selection.bottom))),
  };
}

function pickVisibleTiles(
  scene: Scene,
  model: Group,
  camera: Camera,
  renderer: WebGLRenderer,
  selection: ScreenRect,
  manifest: DatasetManifest,
): ReturnType<typeof collectPickedTiles> {
  const width = Math.max(1, renderer.domElement.clientWidth);
  const height = Math.max(1, renderer.domElement.clientHeight);
  const bounds = selectionBounds(selection, width, height);
  const readWidth = Math.max(1, bounds.right - bounds.left);
  const readHeight = Math.max(1, bounds.bottom - bounds.top);
  const target = new WebGLRenderTarget(width, height, {
    format: RGBAFormat,
    type: UnsignedByteType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  const indexByName = new Map(manifest.materials.map((material, index) => [material.name, index]));
  const pickMaterials = manifest.materials.map((_material, index) => {
    const encoded = index + 1;
    return new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: pickVertexShader,
      fragmentShader: pickFragmentShader,
      uniforms: { encodedId: { value: [encoded % 256 / 255, Math.floor(encoded / 256) / 255] } },
      side: DoubleSide,
      depthTest: true,
      depthWrite: true,
      blending: NoBlending,
    });
  });
  const blankPickMaterial = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: pickVertexShader,
    fragmentShader: pickFragmentShader,
    uniforms: { encodedId: { value: [0, 0] } },
    side: DoubleSide,
    depthTest: true,
    depthWrite: true,
    colorWrite: false,
  });
  const replacements: MaterialReplacement[] = [];
  model.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const original = object.material;
    replacements.push({ mesh: object, material: original });
    if (Array.isArray(original)) {
      object.material = original.map((material) => {
        const index = indexByName.get(material.name);
        return index === undefined ? blankPickMaterial : pickMaterials[index]!;
      });
    } else {
      const index = indexByName.get(original.name);
      object.material = index === undefined ? blankPickMaterial : pickMaterials[index]!;
    }
  });

  const previousTarget = renderer.getRenderTarget();
  const previousBackground = scene.background;
  const previousClearAlpha = renderer.getClearAlpha();
  const previousClearColor = renderer.getClearColor(new Color()).clone();
  const pixels = new Uint8Array(readWidth * readHeight * 4);
  try {
    scene.background = null;
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, bounds.left, height - bounds.bottom, readWidth, readHeight, pixels);
  } finally {
    for (const replacement of replacements) replacement.mesh.material = replacement.material;
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    scene.background = previousBackground;
    target.dispose();
    for (const material of pickMaterials) material.dispose();
    blankPickMaterial.dispose();
  }
  return collectPickedTiles(pixels, readWidth, readHeight, manifest.materials);
}

export class DetailTileOverlay {
  private readonly group = new Group();
  private readonly loader = new ImageBitmapLoader();
  private readonly baseMeshes = new Map<string, Mesh[]>();
  private readonly baseMaterials = new Map<string, MeshStandardMaterial>();
  private readonly attachedTiles = new Map<string, AttachedDetailTile>();
  private readonly discardMaterial = new ShaderMaterial({
    vertexShader: discardVertexShader,
    fragmentShader: discardFragmentShader,
    side: DoubleSide,
  });
  private generation = 0;
  private active = false;
  private source: DetailOverlaySource | undefined;
  private estimatedGpuBytes = 0;
  private batchController: AbortController | undefined;

  constructor(
    private readonly scene: Scene,
    private readonly model: Group,
    private readonly camera: Camera,
    private readonly renderer: WebGLRenderer,
    private readonly manifest: DatasetManifest,
    private detailBudgetBytes: number,
    private readonly onStatus: (status: DetailOverlayStatus) => void,
  ) {
    this.group.name = "Source-resolution detail tiles";
    this.group.renderOrder = 5;
    this.scene.add(this.group);
    this.loader.setOptions({ imageOrientation: "none", premultiplyAlpha: "none" });
    this.model.updateMatrixWorld(true);
    this.model.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) {
        const name = material.name;
        const meshes = this.baseMeshes.get(name) ?? [];
        meshes.push(object);
        this.baseMeshes.set(name, meshes);
        if (material instanceof MeshStandardMaterial && !this.baseMaterials.has(name)) {
          this.baseMaterials.set(name, material);
        }
      }
    });
  }

  isActive(): boolean { return this.active; }

  isManual(): boolean { return this.active && this.source === "manual"; }

  isAutomatic(): boolean { return this.active && this.source === "automatic"; }

  setBudgetBytes(bytes: number): void {
    this.detailBudgetBytes = bytes;
  }

  async show(selection: ScreenRect, source: DetailOverlaySource = "manual"): Promise<void> {
    const preserveLoadedTiles = source === "automatic" && this.isAutomatic();
    this.batchController?.abort();
    this.batchController = undefined;
    this.generation += 1;
    if (!preserveLoadedTiles) this.disposeAttachedTiles();
    this.active = true;
    this.source = source;
    const generation = this.generation;
    this.onStatus({
      phase: "analyzing", source, requestedTiles: 0, loadedTiles: 0, materialCount: 0,
      estimatedGpuBytes: preserveLoadedTiles ? this.estimatedGpuBytes : 0, coverage: 0,
    });
    try {
      this.group.visible = false;
      const picked = pickVisibleTiles(this.scene, this.model, this.camera, this.renderer, selection, this.manifest);
      if (picked.length === 0) {
        this.group.visible = true;
        this.clear(false);
        this.onStatus({
          phase: "error", source, requestedTiles: 0, loadedTiles: 0, materialCount: 0,
          estimatedGpuBytes: 0, coverage: 1, message: "No visible reef found inside that box.",
        });
        return;
      }
      const plan = planDetailTiles(picked, this.manifest.materials, this.detailBudgetBytes);
      const materialCount = new Set(plan.tiles.map((tile) => tile.materialIndex)).size;
      this.group.visible = true;
      if (plan.coverage < 0.999) {
        if (!preserveLoadedTiles) {
          this.active = false;
          this.source = undefined;
          this.estimatedGpuBytes = 0;
        }
        this.onStatus({
          phase: "limited", source, requestedTiles: plan.totalTiles,
          loadedTiles: preserveLoadedTiles ? this.attachedTiles.size : 0, materialCount,
          estimatedGpuBytes: preserveLoadedTiles ? this.estimatedGpuBytes : 0, coverage: plan.coverage,
          message: `That box needs ${(plan.requiredGpuBytes / 1024 ** 3).toFixed(1)} GiB, exceeding the detail share of your GPU budget. Draw a smaller box.`,
        });
        return;
      }
      const reconciliation = reconcileDetailTiles(new Set(this.attachedTiles.keys()), plan.tiles);
      for (const key of reconciliation.removed) this.disposeAttachedTile(key);
      this.estimatedGpuBytes = plan.estimatedGpuBytes;
      this.onStatus({
        phase: "loading", source, requestedTiles: plan.tiles.length, loadedTiles: reconciliation.retained.size, materialCount,
        estimatedGpuBytes: plan.estimatedGpuBytes, coverage: plan.coverage,
      });
      await this.loadPlan(plan, reconciliation.missing, generation, materialCount);
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof Error ? error.message : String(error);
      this.clear(false);
      this.onStatus({
        phase: "error", source, requestedTiles: 0, loadedTiles: 0, materialCount: 0,
        estimatedGpuBytes: 0, coverage: 0,
        message,
      });
    }
  }

  clear(emit = true): void {
    this.batchController?.abort();
    this.batchController = undefined;
    this.generation += 1;
    this.active = false;
    this.source = undefined;
    this.estimatedGpuBytes = 0;
    this.disposeAttachedTiles();
    if (emit) this.onStatus({
      phase: "idle", requestedTiles: 0, loadedTiles: 0, materialCount: 0,
      estimatedGpuBytes: 0, coverage: 1,
    });
  }

  dispose(): void {
    this.clear(false);
    this.discardMaterial.dispose();
    this.scene.remove(this.group);
  }

  private async loadPlan(
    plan: DetailTilePlan,
    missing: PlannedDetailTile[],
    generation: number,
    materialCount: number,
  ): Promise<void> {
    const loadedKeys = new Set(
      plan.tiles
        .map((tile) => detailTileKey(tile.materialIndex, tile.size, tile.x, tile.y))
        .filter((key) => this.attachedTiles.has(key)),
    );
    const reportProgress = (): void => {
      this.onStatus({
        phase: loadedKeys.size === plan.tiles.length ? "ready" : "loading", source: this.source,
        requestedTiles: plan.tiles.length,
        loadedTiles: loadedKeys.size,
        materialCount,
        estimatedGpuBytes: plan.estimatedGpuBytes,
        coverage: plan.coverage,
      });
    };
    if (missing.length === 0) {
      reportProgress();
      return;
    }
    const controller = new AbortController();
    this.batchController = controller;
    try {
      const response = await fetch(`/api/detail-tiles/${encodeURIComponent(this.manifest.id)}/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tiles: missing.map(({ materialIndex, size, x, y }) => ({ materialIndex, size, x, y })) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = response.headers.get("Content-Type")?.includes("application/json")
          ? (await response.json() as { error?: string }).error
          : undefined;
        throw new Error(error ?? `Detail batch failed (${response.status}).`);
      }
      if (!response.body || !response.headers.get("Content-Type")?.includes("application/x-reefstream-tiles")) {
        throw new Error("Detail batch API is unavailable.");
      }
      for await (const { index, png } of readTileFrames(response.body)) {
        if (generation !== this.generation) return;
        const tile = missing[index];
        const key = tile ? detailTileKey(tile.materialIndex, tile.size, tile.x, tile.y) : undefined;
        if (!tile || !key || loadedKeys.has(key)) throw new Error("Detail batch returned an unexpected tile.");
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(png)], { type: "image/png" }), {
          imageOrientation: "none", premultiplyAlpha: "none",
        });
        this.attachTile(tile, bitmap, generation);
        if (generation !== this.generation) return;
        loadedKeys.add(key);
        reportProgress();
      }
      if (loadedKeys.size !== plan.tiles.length) throw new Error("Detail batch ended before all tiles arrived.");
      return;
    } catch (error) {
      if (generation !== this.generation) return;
      controller.abort();
      // Older servers and interrupted batches can still use the individual tile route.
      console.warn("Detail batch unavailable; loading remaining tiles individually.", error);
    } finally {
      if (this.batchController === controller) this.batchController = undefined;
    }

    const remaining = missing.filter((tile) => !loadedKeys.has(detailTileKey(tile.materialIndex, tile.size, tile.x, tile.y)));
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < remaining.length) {
        const tile = remaining[cursor++]!;
        await this.loadTile(tile, generation);
        if (generation !== this.generation) return;
        loadedKeys.add(detailTileKey(tile.materialIndex, tile.size, tile.x, tile.y));
        reportProgress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, remaining.length) }, worker));
  }

  private async loadTile(tile: PlannedDetailTile, generation: number): Promise<void> {
    const url = `/api/detail-tile/${encodeURIComponent(this.manifest.id)}/${tile.materialIndex}/${tile.size}/${tile.x}/${tile.y}`;
    const bitmap = await this.loader.loadAsync(url);
    this.attachTile(tile, bitmap, generation);
  }

  private attachTile(tile: PlannedDetailTile, bitmap: ImageBitmap, generation: number): void {
    const key = detailTileKey(tile.materialIndex, tile.size, tile.x, tile.y);
    if (this.attachedTiles.has(key)) {
      bitmap.close();
      return;
    }
    const asset = this.manifest.materials[tile.materialIndex];
    const baseMaterial = asset ? this.baseMaterials.get(asset.name) : undefined;
    if (!asset || !baseMaterial) {
      bitmap.close();
      return;
    }
    const texture = new Texture(bitmap);
    texture.name = `${asset.name}:detail:${tile.x}:${tile.y}`;
    texture.colorSpace = SRGBColorSpace;
    texture.flipY = false;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    if (generation !== this.generation) {
      texture.dispose();
      bitmap.close();
      return;
    }
    const material = createDetailMaterial(baseMaterial, texture, tile);
    const overlays: Mesh[] = [];
    for (const base of this.baseMeshes.get(asset.name) ?? []) {
      const overlayMaterials = Array.isArray(base.material)
        ? base.material.map((candidate) => candidate.name === asset.name ? material : this.discardMaterial)
        : material;
      const overlay = new Mesh(base.geometry, overlayMaterials);
      overlay.name = `${asset.name} detail ${tile.x},${tile.y}`;
      overlay.matrixAutoUpdate = false;
      overlay.matrix.copy(base.matrixWorld);
      overlay.frustumCulled = base.frustumCulled;
      overlay.renderOrder = 5;
      this.group.add(overlay);
      overlays.push(overlay);
    }
    this.attachedTiles.set(key, { texture, material, overlays });
  }

  private disposeAttachedTile(key: string): void {
    const attached = this.attachedTiles.get(key);
    if (!attached) return;
    for (const overlay of attached.overlays) this.group.remove(overlay);
    attached.material.dispose();
    const image = attached.texture.image as ImageBitmap | undefined;
    attached.texture.dispose();
    image?.close?.();
    this.attachedTiles.delete(key);
  }

  private disposeAttachedTiles(): void {
    for (const key of [...this.attachedTiles.keys()]) this.disposeAttachedTile(key);
    this.group.clear();
  }
}
