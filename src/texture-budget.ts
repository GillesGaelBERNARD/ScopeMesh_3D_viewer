export const MIN_TEXTURE_BUDGET_MIB = 512;
export const MAX_TEXTURE_BUDGET_MIB = 12 * 1024;
export const TEXTURE_BUDGET_STEP_MIB = 256;
export const DEFAULT_TEXTURE_BUDGET_MIB = 2048;

const MiB = 1024 * 1024;

export interface TextureBudgets {
  totalMiB: number;
  normalBytes: number;
  backgroundBytes: number;
  detailBytes: number;
}

export function textureBudgets(requestedMiB: number): TextureBudgets {
  const finite = Number.isFinite(requestedMiB) ? requestedMiB : DEFAULT_TEXTURE_BUDGET_MIB;
  const snapped = Math.round(finite / TEXTURE_BUDGET_STEP_MIB) * TEXTURE_BUDGET_STEP_MIB;
  const totalMiB = Math.min(MAX_TEXTURE_BUDGET_MIB, Math.max(MIN_TEXTURE_BUDGET_MIB, snapped));
  const backgroundMiB = totalMiB / 4;
  return {
    totalMiB,
    normalBytes: totalMiB * MiB,
    backgroundBytes: backgroundMiB * MiB,
    detailBytes: (totalMiB - backgroundMiB) * MiB,
  };
}

export function formatBudgetGiB(mebibytes: number): string {
  return `${(mebibytes / 1024).toFixed(1)} GiB`;
}
