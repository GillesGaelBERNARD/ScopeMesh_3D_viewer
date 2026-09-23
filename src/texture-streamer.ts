import {
  ImageBitmapLoader,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  WebGLRenderer,
} from "three";
import type { DatasetManifest, TextureTier } from "./domain.ts";
import type { LodPlan } from "./lod-planner.ts";

export interface StreamingStatus {
  loading: number;
  fullCount: number;
  mediumCount: number;
  dynamicBytes: number;
  sourceResolutionComplete: boolean;
}

export function hasCompleteSourceTextureSet(activeTiers: Iterable<TextureTier>, expectedCount: number): boolean {
  let fullCount = 0;
  for (const tier of activeTiers) {
    if (tier !== "full") return false;
    fullCount += 1;
  }
  return expectedCount > 0 && fullCount === expectedCount;
}

interface MaterialState {
  materials: MeshStandardMaterial[];
  lowTexture: Texture;
  activeTexture: Texture;
  activeTier: TextureTier;
  requestedTier: TextureTier;
  generation: number;
}

export class TextureStreamer {
  private readonly states = new Map<string, MaterialState>();
  private readonly loader = new ImageBitmapLoader();
  private loading = 0;
  private plan?: LodPlan;
  private readonly pending: (() => Promise<void>)[] = [];
  private activeLoads = 0;

  constructor(
    private readonly manifest: DatasetManifest,
    private readonly renderer: WebGLRenderer,
    private readonly onStatus: (status: StreamingStatus) => void,
  ) {
    this.loader.setOptions({ imageOrientation: "none", premultiplyAlpha: "none" });
  }

  register(material: MeshStandardMaterial): void {
    if (!material.map || !material.name) return;
    const state = this.states.get(material.name);
    if (state) {
      state.materials.push(material);
      return;
    }
    this.states.set(material.name, {
      materials: [material],
      lowTexture: material.map,
      activeTexture: material.map,
      activeTier: "low",
      requestedTier: "low",
      generation: 0,
    });
  }

  apply(plan: LodPlan): void {
    this.plan = plan;
    for (const asset of this.manifest.materials) {
      const state = this.states.get(asset.name);
      if (!state) continue;
      const tier = plan.tiers.get(asset.name) ?? "low";
      if (tier === state.requestedTier) continue;
      state.requestedTier = tier;
      state.generation += 1;
      const generation = state.generation;
      if (tier === "low") {
        this.applyTexture(state, state.lowTexture, "low");
      } else {
        this.pending.push(async () => {
          await this.loadTier(asset.name, tier, generation);
        });
      }
    }
    this.pump();
    this.emitStatus();
  }

  dispose(): void {
    for (const state of this.states.values()) {
      if (state.activeTexture !== state.lowTexture) state.activeTexture.dispose();
    }
    this.pending.length = 0;
  }

  private async loadTier(materialName: string, tier: Exclude<TextureTier, "low">, generation: number): Promise<void> {
    const asset = this.manifest.materials.find((item) => item.name === materialName);
    const state = this.states.get(materialName);
    if (!asset || !state) return;
    if (state.generation !== generation || state.requestedTier !== tier) return;
    this.loading += 1;
    this.emitStatus();
    try {
      const bitmap = await this.loader.loadAsync(asset[tier].url);
      const texture = new Texture(bitmap);
      texture.name = `${materialName}:${tier}`;
      texture.colorSpace = SRGBColorSpace;
      texture.flipY = false;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      texture.needsUpdate = true;
      if (state.generation !== generation || state.requestedTier !== tier) {
        texture.dispose();
        bitmap.close();
        return;
      }
      this.applyTexture(state, texture, tier);
    } catch (error) {
      console.error(`Texture stream failed for ${materialName}:${tier}`, error);
      state.requestedTier = state.activeTier;
    } finally {
      this.loading -= 1;
      this.emitStatus();
    }
  }

  private applyTexture(state: MaterialState, texture: Texture, tier: TextureTier): void {
    const previous = state.activeTexture;
    for (const material of state.materials) {
      material.map = texture;
      material.needsUpdate = true;
    }
    state.activeTexture = texture;
    state.activeTier = tier;
    if (previous !== state.lowTexture && previous !== texture) {
      const image = previous.image as ImageBitmap | undefined;
      previous.dispose();
      image?.close?.();
    }
  }

  private pump(): void {
    while (this.activeLoads < 2 && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.activeLoads += 1;
      void job().finally(() => {
        this.activeLoads -= 1;
        this.pump();
      });
    }
  }

  private emitStatus(): void {
    this.onStatus({
      loading: this.loading + this.pending.length,
      fullCount: this.plan?.fullCount ?? 0,
      mediumCount: this.plan?.mediumCount ?? 0,
      dynamicBytes: this.plan?.dynamicBytes ?? 0,
      sourceResolutionComplete: hasCompleteSourceTextureSet(
        [...this.states.values()].map((state) => state.activeTier),
        this.manifest.materials.length,
      ),
    });
  }
}
