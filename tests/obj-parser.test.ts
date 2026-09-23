import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findObjMaterialLibrary, parseMtl, parseObj } from "../scripts/obj-parser.ts";

describe("OBJ preparation boundary", () => {
  it("finds the material library without buffering a greater-than-2-GiB OBJ", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reefstream-"));
    try {
      const obj = join(directory, "huge.obj");
      await writeFile(obj, "# generated fixture\nmtllib sample.mtl\n");
      await truncate(obj, 2 * 1024 ** 3 + 1);

      await expect(findObjMaterialLibrary(obj)).resolves.toBe("sample.mtl");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("triangulates faces, preserves material regions, and converts UV orientation for glTF", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reefstream-"));
    const obj = join(directory, "sample.obj");
    await writeFile(obj, [
      "v 0 0 0", "v 2 0 0", "v 2 2 0", "v 0 2 0",
      "vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1",
      "vn 0 0 1", "usemtl coral", "f 1/1/1 2/2/1 3/3/1 4/4/1",
    ].join("\n"));
    const result = await parseObj(obj);
    expect(result.triangleCount).toBe(2);
    expect(result.primitives).toHaveLength(1);
    expect(result.primitives[0]?.materialName).toBe("coral");
    expect(result.primitives[0]?.uvs.slice(0, 2)).toEqual([0, 1]);
    expect(result.bounds).toEqual({ min: [0, 0, 0], max: [2, 2, 0] });
  });

  it("maps MTL material names to their texture files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reefstream-"));
    const mtl = join(directory, "sample.mtl");
    await writeFile(mtl, "newmtl coral\nKd 1 1 1\nmap_Kd coral texture.png\n");
    expect((await parseMtl(mtl)).get("coral")?.diffuseMap).toBe("coral texture.png");
  });
});
