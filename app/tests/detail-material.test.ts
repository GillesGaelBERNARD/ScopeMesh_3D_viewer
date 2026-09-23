import { describe, expect, it } from "vitest";
import { Color, MeshStandardMaterial, Texture } from "three";
import { createDetailMaterial } from "../src/detail-material.ts";

describe("detail tile material", () => {
  it("preserves standard lighting properties while remapping the source tile", () => {
    const base = new MeshStandardMaterial({
      color: new Color(0x7ea9bd),
      roughness: 0.37,
      metalness: 0.12,
    });
    base.envMapIntensity = 0.42;
    const texture = new Texture();
    const detail = createDetailMaterial(base, texture, {
      coreUv: [0.25, 0.5, 0.5, 0.75],
      cropUv: [0.24, 0.49, 0.51, 0.76],
    });

    expect(detail).toBeInstanceOf(MeshStandardMaterial);
    expect(detail).not.toBe(base);
    expect(detail.map).toBe(texture);
    expect(detail.color.getHex()).toBe(base.color.getHex());
    expect(detail.roughness).toBe(base.roughness);
    expect(detail.metalness).toBe(base.metalness);
    expect(detail.envMapIntensity).toBe(base.envMapIntensity);
    expect(detail.depthWrite).toBe(false);
    expect(detail.polygonOffset).toBe(true);

    const shader = {
      uniforms: {},
      vertexShader: "#include <common>\n#include <uv_vertex>",
      fragmentShader: "#include <common>\n#include <map_fragment>",
    };
    detail.onBeforeCompile(shader as never, {} as never);

    expect(shader.vertexShader).toContain("detailSourceUv = fract(uv)");
    expect(shader.fragmentShader).toContain("discard");
    expect(shader.fragmentShader).toContain("texture2D(map, detailTileUv)");
    expect(shader.uniforms).toHaveProperty("detailCoreUv");
    expect(shader.uniforms).toHaveProperty("detailCropUv");
  });
});
