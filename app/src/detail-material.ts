import {
  MeshStandardMaterial,
  Texture,
  Vector4,
  type WebGLRenderer,
  type WebGLProgramParametersWithUniforms,
} from "three";

export interface DetailMaterialRegion {
  coreUv: [number, number, number, number];
  cropUv: [number, number, number, number];
}

export function createDetailMaterial(
  base: MeshStandardMaterial,
  texture: Texture,
  region: DetailMaterialRegion,
): MeshStandardMaterial {
  const material = base.clone();
  material.map = texture;
  material.depthWrite = false;
  material.polygonOffset = true;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -1;
  material.customProgramCacheKey = () => "reefstream-lit-detail-v1";
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, _renderer: WebGLRenderer) => {
    shader.uniforms.detailCoreUv = { value: new Vector4(...region.coreUv) };
    shader.uniforms.detailCropUv = { value: new Vector4(...region.cropUv) };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 detailSourceUv;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\ndetailSourceUv = fract(uv);");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec2 detailSourceUv;\nuniform vec4 detailCoreUv;\nuniform vec4 detailCropUv;",
      )
      .replace("#include <map_fragment>", `
        if (
          detailSourceUv.x < detailCoreUv.x || detailSourceUv.y < detailCoreUv.y ||
          detailSourceUv.x > detailCoreUv.z || detailSourceUv.y > detailCoreUv.w
        ) discard;
        vec2 detailTileUv = (detailSourceUv - detailCropUv.xy) / (detailCropUv.zw - detailCropUv.xy);
        vec4 sampledDiffuseColor = texture2D(map, detailTileUv);
        diffuseColor *= sampledDiffuseColor;
      `);
  };
  material.needsUpdate = true;
  return material;
}
