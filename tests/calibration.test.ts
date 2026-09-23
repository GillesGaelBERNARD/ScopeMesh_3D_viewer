import { describe, expect, it } from "vitest";
import { fitScale, formatMeasuredDistance, type CalibrationReference } from "../src/calibration.ts";

function reference(rawDistance: number, knownValue: number, unit: CalibrationReference["unit"] = "m"): CalibrationReference {
  return { id: crypto.randomUUID(), rawDistance, knownValue, unit };
}

describe("calibration scale", () => {
  it("fits one scale across multiple known references", () => {
    const scale = fitScale([
      reference(2, 1),
      reference(4, 2),
      reference(1, 50, "cm"),
    ]);
    expect(scale).toBeCloseTo(0.5);
  });

  it("ignores invalid references", () => {
    expect(fitScale([reference(0, 1), reference(2, -1)])).toBeUndefined();
  });

  it("labels uncalibrated values as model units and calibrated values in useful real units", () => {
    expect(formatMeasuredDistance(2.5)).toBe("2.500 model units");
    expect(formatMeasuredDistance(2.5, 0.1)).toBe("25.0 cm");
    expect(formatMeasuredDistance(2.5, 1)).toBe("2.500 m");
  });
});
