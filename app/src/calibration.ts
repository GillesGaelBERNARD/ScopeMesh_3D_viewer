export type LengthUnit = "mm" | "cm" | "m";

export interface CalibrationReference {
  id: string;
  rawDistance: number;
  knownValue: number;
  unit: LengthUnit;
}

const METERS_PER_UNIT: Record<LengthUnit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
};

export function knownMeters(reference: CalibrationReference): number {
  return reference.knownValue * METERS_PER_UNIT[reference.unit];
}

export function fitScale(references: CalibrationReference[]): number | undefined {
  const valid = references.filter((reference) =>
    Number.isFinite(reference.rawDistance)
    && reference.rawDistance > 0
    && Number.isFinite(reference.knownValue)
    && reference.knownValue > 0,
  );
  if (valid.length === 0) return undefined;
  // Least-squares fit constrained through the origin: real metres = scale × model units.
  const numerator = valid.reduce((sum, reference) => sum + reference.rawDistance * knownMeters(reference), 0);
  const denominator = valid.reduce((sum, reference) => sum + reference.rawDistance ** 2, 0);
  return denominator > 0 ? numerator / denominator : undefined;
}

export function formatMeasuredDistance(rawDistance: number, scale?: number): string {
  if (!scale) return `${rawDistance.toFixed(3)} model units`;
  const meters = rawDistance * scale;
  if (meters < 0.01) return `${(meters * 1000).toFixed(1)} mm`;
  if (meters < 1) return `${(meters * 100).toFixed(1)} cm`;
  return `${meters.toFixed(3)} m`;
}

