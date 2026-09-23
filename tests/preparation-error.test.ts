import { describe, expect, it } from "vitest";
import { concisePreparationError } from "../src/preparation-error.ts";

describe("concisePreparationError", () => {
  it("explains how to restore a missing MTL companion file", () => {
    const stderr = [
      "Error: ENOENT: no such file or directory, open 'I:\\survey\\H.mtl'",
      "    at async open (node:internal/fs/promises:638:25)",
    ].join("\n");

    expect(concisePreparationError(stderr, 1)).toBe([
      "Missing material file — H.mtl",
      "The OBJ refers to H.mtl, but ScopeMesh cannot find it in the model folder.",
      "Restore H.mtl beside the OBJ. In Metashape, build a texture and export the OBJ again with texture and UV options enabled.",
    ].join("\n"));
  });

  it("explains how to restore a missing texture image", () => {
    const stderr = "Error: Cannot read texture \"textures/coral.jpg\": ENOENT: no such file or directory";

    expect(concisePreparationError(stderr, 1)).toBe([
      "Missing texture image — coral.jpg",
      "An MTL material refers to textures/coral.jpg, but ScopeMesh cannot find that image.",
      "Restore the image at the path recorded in the MTL, or export the textured model from Metashape again.",
    ].join("\n"));
  });

  it("guides an OBJ export that has no material-library reference", () => {
    expect(concisePreparationError("Error: OBJ does not reference an MTL file", 1)).toBe([
      "OBJ has no material-file reference",
      "A textured OBJ needs an mtllib line that points to its companion .mtl file.",
      "In Metashape, build a texture first, then export OBJ with texture and UV options enabled.",
    ].join("\n"));
  });

  it("guides an MTL material that has no diffuse texture", () => {
    expect(concisePreparationError("Error: Material Solid has no map_Kd texture", 1)).toBe([
      "Material has no texture image — Solid",
      "The MTL material “Solid” does not contain a map_Kd image reference.",
      "Export the textured model from Metashape again, or add the correct map_Kd image path to the MTL.",
    ].join("\n"));
  });

  it("shows the actual converter error instead of the final stack line", () => {
    const stderr = [
      "Error: Cannot read texture odm_material0000.png: Input image exceeds pixel limit",
      "    at main (C:\\viewer\\scripts\\prepare.ts:61:46)",
      "    at processTicksAndRejections (node:internal/process/task_queues:105:5)",
    ].join("\n");

    expect(concisePreparationError(stderr, 1)).toBe(
      "Cannot read texture odm_material0000.png: Input image exceeds pixel limit",
    );
  });

  it("provides a useful fallback when the converter exits silently", () => {
    expect(concisePreparationError("", 7)).toBe("Conversion stopped with code 7.");
  });
});
