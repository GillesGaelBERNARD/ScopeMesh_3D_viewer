import type { MaterialAsset, QualityMode, TextureTier } from "./domain.ts";

export interface MaterialView {
  material: MaterialAsset;
  visible: boolean;
  projectedPixels: number;
  selected: boolean;
}

export interface LodPlan {
  tiers: Map<string, TextureTier>;
  dynamicBytes: number;
  fullCount: number;
  mediumCount: number;
}

export function projectedPixelDiameter(
  radius: number,
  distance: number,
  verticalFovRadians: number,
  viewportHeight: number,
): number {
  if (distance <= 0 || radius <= 0) return 0;
  return (2 * radius * viewportHeight) / (2 * distance * Math.tan(verticalFovRadians / 2));
}

export function desiredTextureTier(view: MaterialView, mode: QualityMode): TextureTier {
  if (!view.visible || mode === "overview") return "low";
  if (view.selected) return "full";
  const fullThreshold = mode === "detail" ? 700 : 1250;
  const mediumThreshold = mode === "detail" ? 110 : 220;
  if (view.projectedPixels >= fullThreshold) return "full";
  if (view.projectedPixels >= mediumThreshold) return "medium";
  return "low";
}

export function planTextureTiers(
  views: MaterialView[],
  mode: QualityMode,
  dynamicBudgetBytes: number,
): LodPlan {
  const tiers = new Map<string, TextureTier>(views.map(({ material }) => [material.name, "low"]));
  const completeSourceBytes = views.reduce((sum, view) => sum + view.material.full.estimatedGpuBytes, 0);
  if (mode !== "overview" && completeSourceBytes <= dynamicBudgetBytes) {
    for (const view of views) tiers.set(view.material.name, "full");
    return {
      tiers,
      dynamicBytes: completeSourceBytes,
      fullCount: views.length,
      mediumCount: 0,
    };
  }
  let dynamicBytes = 0;
  let fullCount = 0;
  let mediumCount = 0;

  const candidates = views
    .filter((view) => view.visible && desiredTextureTier(view, mode) !== "low")
    .sort((a, b) => Number(b.selected) - Number(a.selected) || b.projectedPixels - a.projectedPixels);

  for (const view of candidates) {
    const desired = desiredTextureTier(view, mode);
    const choices: TextureTier[] = desired === "full" ? ["full", "medium"] : ["medium"];
    for (const tier of choices) {
      const cost = view.material[tier].estimatedGpuBytes;
      if (dynamicBytes + cost > dynamicBudgetBytes) continue;
      tiers.set(view.material.name, tier);
      dynamicBytes += cost;
      if (tier === "full") fullCount += 1;
      else mediumCount += 1;
      break;
    }
  }
  return { tiers, dynamicBytes, fullCount, mediumCount };
}
