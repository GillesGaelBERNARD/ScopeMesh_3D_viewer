import type { QualityMode, TextureTier } from "./domain.ts";
import { desiredTextureTier, type LodPlan, type MaterialView } from "./lod-planner.ts";

export const AUTOMATIC_DETAIL_SETTLE_MS = 500;

function tierHasLessResolution(view: MaterialView, tier: TextureTier): boolean {
  const current = view.material[tier];
  const source = view.material.full;
  return current.width < source.width || current.height < source.height;
}

export function needsAutomaticDetail(
  views: MaterialView[],
  plan: LodPlan,
  mode: QualityMode,
): boolean {
  if (mode !== "detail") return false;
  return views.some((view) => {
    if (!view.visible || desiredTextureTier(view, mode) !== "full") return false;
    const plannedTier = plan.tiers.get(view.material.name) ?? "low";
    return plannedTier !== "full" && tierHasLessResolution(view, plannedTier);
  });
}
