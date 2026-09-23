export function concisePreparationError(stderr: string, exitCode: number | null): string {
  const cause = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("at "));
  if (cause) {
    const message = cause.replace(/^Error:\s*/, "");
    const missingTexture = message.match(/^Cannot read texture "([^"]+)":.*\bENOENT\b/i);
    if (missingTexture?.[1]) {
      const texturePath = missingTexture[1];
      const textureName = texturePath.split(/[\\/]/).at(-1) ?? texturePath;
      return [
        `Missing texture image — ${textureName}`,
        `An MTL material refers to ${texturePath}, but ScopeMesh cannot find that image.`,
        "Restore the image at the path recorded in the MTL, or export the textured model from Metashape again.",
      ].join("\n");
    }

    const missingPath = message.match(/\bENOENT\b.*?['"]([^'"]+)['"]\s*$/i)?.[1];
    if (missingPath?.toLowerCase().endsWith(".mtl")) {
      const materialName = missingPath.split(/[\\/]/).at(-1) ?? missingPath;
      return [
        `Missing material file — ${materialName}`,
        `The OBJ refers to ${materialName}, but ScopeMesh cannot find it in the model folder.`,
        `Restore ${materialName} beside the OBJ. In Metashape, build a texture and export the OBJ again with texture and UV options enabled.`,
      ].join("\n");
    }

    if (message === "OBJ does not reference an MTL file") {
      return [
        "OBJ has no material-file reference",
        "A textured OBJ needs an mtllib line that points to its companion .mtl file.",
        "In Metashape, build a texture first, then export OBJ with texture and UV options enabled.",
      ].join("\n");
    }

    const materialWithoutTexture = message.match(/^Material (.+) has no map_Kd texture$/);
    if (materialWithoutTexture?.[1]) {
      const materialName = materialWithoutTexture[1];
      return [
        `Material has no texture image — ${materialName}`,
        `The MTL material “${materialName}” does not contain a map_Kd image reference.`,
        "Export the textured model from Metashape again, or add the correct map_Kd image path to the MTL.",
      ].join("\n");
    }

    return message;
  }
  return `Conversion stopped with code ${exitCode ?? "unknown"}.`;
}
