# ReefStream photogrammetry corpus test

Date: 2026-09-22  
Corpus: `I:\Gilles\Documents\TRAVAIL\photogrammetry`

## Outcome

- Discovered 52 OBJ files recursively (2.20 GiB of OBJ geometry).
- Fresh preparation through the app's `/api/prepare` route: 49 passed, 3 failed because of damaged or missing source texture files.
- Successful preparations covered 21,485,476 triangles and 2,011 material sections in total.
- Preparation and full tier-asset verification took 29.03 minutes.
- Browser/WebGL smoke test: all 49 prepared datasets passed; 0 browser failures and 3 preparation-failure skips.
- Existing automated baseline: 18/18 tests passed.
- Production build passed. Vite reported its existing warning for a JavaScript chunk over 500 kB.

For every successful preparation, the test verified the manifest, compact glTF, positive triangle count, consistent material count, and HTTP access to every low-, medium-, and full-resolution texture URL. The browser test then opened each generated dataset in Chrome, waited for `100%` / `Overview ready`, checked that the WebGL2 canvas was live, exercised Top, Wireframe, and Perspective controls, and failed on console exceptions, HTTP errors, or network load failures.

## Source-data failures

### 15 — Favites_1

OBJ: `I:\Gilles\Documents\TRAVAIL\photogrammetry\DONE\Favites_1\textured_model\odm_textured_model_geo.obj`

- Preparation error: `Cannot optimize texture "odm_textured_model_geo_material0000_map_Kd.png": vipspng: libpng read error`
- Full folder sweep: exactly 1 of 29 referenced atlases fails decoding.
- SHA-256: `D758248BF8EC2E1B70BDE954F3E07FC6AB00031B347B7862FB89E9A79386D1C0`
- PNG validation: invalid `IDAT` CRC at byte 7,941,505; no reachable `IEND` after the corrupt chunk.
- The failure reproduced twice in fresh Sharp processes; adjacent atlas 0001 decoded twice.

### 18 — Lobophyllia_patch_1

OBJ: `I:\Gilles\Documents\TRAVAIL\photogrammetry\DONE\Lobophyllia_patch_1\textured_model\odm_textured_model_geo.obj`

- Preparation error: `Cannot optimize texture "odm_textured_model_geo_material0008_map_Kd.png": vipspng: libpng read error`
- Full folder sweep: exactly 1 of 20 referenced atlases fails decoding.
- SHA-256: `D79687C2D5A1AB4B7BE01DBD7CE8FCF951DA077179F287F738A5081E41BF8789`
- PNG validation: invalid `IDAT` CRC at byte 935,289; no reachable `IEND` after the corrupt chunk.
- The failure reproduced twice in fresh Sharp processes; adjacent atlas 0007 decoded twice.

### 24 — PL_Dipsastrea

OBJ: `I:\Gilles\Documents\TRAVAIL\photogrammetry\DONE\PL_Dipsastrea\textured_model\odm_textured_model_geo.obj`

- Preparation stopped at missing `odm_textured_model_geo_material0009_map_Kd.png`.
- The MTL references 20 atlases, but 11 are absent: 0009 through 0019 inclusive.
- A corpus-wide reference audit found no other missing MTL or texture files.

These failures are caused by the source exports. No app-code failure was found in the 49 complete models.

## Stress cases that passed

- Largest OBJ: `Max_Planck_Porites/.../texturedMesh.obj` — 418,094,393 bytes, 5,347,651 rendered triangles, 29 materials.
- Most materials: `Emily_large_area/.../odm_textured_model_geo.obj` — 107 materials, 317,606 triangles.
- Next widest material set: `PL_multiple_large_Porites/.../odm_textured_model_geo.obj` — 97 materials, 346,997 triangles.

## Machine-readable evidence

- `corpus-smoke-2026-09-22.json` — per-OBJ preparation, asset, timing, triangle, and material results.
- `browser-corpus-smoke-2026-09-22.json` — per-dataset DOM, WebGL, console, network, and control-smoke results.

