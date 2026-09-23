import "./style.css";
import {
  AmbientLight, BufferGeometry, Color, DirectionalLight, Float32BufferAttribute, Frustum, Group,
  HemisphereLight, Line, LineBasicMaterial, Matrix4, Mesh, MeshStandardMaterial, PerspectiveCamera,
  Raycaster, Scene, Sphere, SRGBColorSpace, Vector2, Vector3, WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { fitScale, formatMeasuredDistance, type CalibrationReference, type LengthUnit } from "./calibration.ts";
import { AUTOMATIC_DETAIL_SETTLE_MS, needsAutomaticDetail } from "./automatic-detail.ts";
import { DetailTileOverlay, type DetailOverlayStatus } from "./detail-tile-overlay.ts";
import { readDetailCacheResponse, type DetailCacheStatus } from "./detail-cache-api.ts";
import type { DatasetManifest, MaterialAsset, QualityMode } from "./domain.ts";
import { planTextureTiers, projectedPixelDiameter, type MaterialView } from "./lod-planner.ts";
import { normalizedRect, type ScreenRect } from "./rectangle-selection.ts";
import {
  DEFAULT_TEXTURE_BUDGET_MIB,
  formatBudgetGiB,
  textureBudgets,
  type TextureBudgets,
} from "./texture-budget.ts";
import { TextureStreamer, type StreamingStatus } from "./texture-streamer.ts";
import { streamingStatusPresentation } from "./streaming-status.ts";

const MiB = 1024 * 1024;
const textureBudgetStorageKey = "reefstream:texture-budget-mib";
type InteractionMode = "navigate" | "measure" | "calibrate" | "select-area";
interface DatasetSummary { id: string; label: string }
interface PreparationJob {
  id: string;
  datasetId: string;
  status: "queued" | "running" | "complete" | "failed";
  progress: number;
  message: string;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const viewport = element<HTMLDivElement>("viewport");
const loading = element<HTMLDivElement>("loading");
const loadingBar = element<HTMLElement>("loading-bar");
const loadingPercent = element<HTMLElement>("loading-percent");
const loadingDetail = element<HTMLElement>("loading-detail");
const datasetName = element<HTMLElement>("dataset-name");
const datasetSwitch = element<HTMLSelectElement>("dataset-switch");
const streamStatus = element<HTMLElement>("stream-status");
const statusDot = element<HTMLElement>("status-dot");
const fullCount = element<HTMLElement>("full-count");
const mediumCount = element<HTMLElement>("medium-count");
const memoryCount = element<HTMLElement>("memory-count");
const measureReadout = element<HTMLElement>("measure-readout");
const qualitySelect = element<HTMLSelectElement>("quality");
const textureBudgetInput = element<HTMLInputElement>("texture-budget");
const textureBudgetOutput = element<HTMLOutputElement>("texture-budget-output");
const controlPanel = document.querySelector<HTMLElement>(".panel");
const panelToggle = element<HTMLButtonElement>("panel-toggle");
const areaStatus = element<HTMLElement>("area-status");
const selectionRectElement = element<HTMLElement>("selection-rect");
const calibrationStatus = element<HTMLElement>("calibration-status");
const calibrationDialog = element<HTMLDialogElement>("calibration-dialog");
const calibrationForm = element<HTMLFormElement>("calibration-form");
const rawReferenceDistance = element<HTMLElement>("raw-reference-distance");
const knownLength = element<HTMLInputElement>("known-length");
const knownUnit = element<HTMLSelectElement>("known-unit");
const importDialog = element<HTMLDialogElement>("import-dialog");
const importForm = element<HTMLFormElement>("import-form");
const modelPathInput = element<HTMLInputElement>("model-path");
const modelLabelInput = element<HTMLInputElement>("model-label");
const importProgress = element<HTMLElement>("import-progress");
const importBar = element<HTMLElement>("import-bar");
const importMessage = element<HTMLElement>("import-message");
const importError = element<HTMLElement>("import-error");
const startImportButton = element<HTMLButtonElement>("start-import");
const detailCacheStatus = element<HTMLElement>("detail-cache-status");
const detailCacheLimit = element<HTMLInputElement>("detail-cache-limit");
const detailCacheLimitOutput = element<HTMLOutputElement>("detail-cache-limit-output");
const clearModelCache = element<HTMLButtonElement>("clear-model-cache");
const clearAllCache = element<HTMLButtonElement>("clear-all-cache");

function clearImportError(): void {
  importError.classList.add("hidden");
  importError.replaceChildren();
}

function showImportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const [title = "Import failed", ...details] = message
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = document.createElement("strong");
  heading.textContent = title;
  const paragraphs = details.map((detail) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = detail;
    return paragraph;
  });
  importError.replaceChildren(heading, ...paragraphs);
  importError.classList.remove("hidden");
}

const sectionInfos = [...document.querySelectorAll<HTMLElement>(".section-info")];
let pinnedSectionInfo: HTMLElement | undefined;

function setSectionInfoOpen(sectionInfo: HTMLElement, open: boolean): void {
  const trigger = sectionInfo.querySelector<HTMLButtonElement>(".info-trigger");
  const popover = sectionInfo.querySelector<HTMLElement>(".info-popover");
  if (!trigger || !popover) return;
  trigger.setAttribute("aria-expanded", String(open));
  popover.hidden = !open;
}

function closeSectionInfos(): void {
  for (const sectionInfo of sectionInfos) setSectionInfoOpen(sectionInfo, false);
}

for (const sectionInfo of sectionInfos) {
  const trigger = sectionInfo.querySelector<HTMLButtonElement>(".info-trigger");
  const close = sectionInfo.querySelector<HTMLButtonElement>(".info-close");
  sectionInfo.addEventListener("pointerenter", () => {
    if (!pinnedSectionInfo) setSectionInfoOpen(sectionInfo, true);
  });
  sectionInfo.addEventListener("pointerleave", () => {
    if (!pinnedSectionInfo) setSectionInfoOpen(sectionInfo, false);
  });
  trigger?.addEventListener("click", () => {
    const shouldOpen = pinnedSectionInfo !== sectionInfo;
    closeSectionInfos();
    pinnedSectionInfo = shouldOpen ? sectionInfo : undefined;
    if (shouldOpen) setSectionInfoOpen(sectionInfo, true);
  });
  close?.addEventListener("click", () => {
    pinnedSectionInfo = undefined;
    setSectionInfoOpen(sectionInfo, false);
    trigger?.focus();
  });
}

document.addEventListener("pointerdown", (event) => {
  if (!pinnedSectionInfo || pinnedSectionInfo.contains(event.target as Node)) return;
  pinnedSectionInfo = undefined;
  closeSectionInfos();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !pinnedSectionInfo) return;
  pinnedSectionInfo = undefined;
  closeSectionInfos();
});

const renderer = new WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
renderer.outputColorSpace = SRGBColorSpace;
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
viewport.append(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x061114);
const camera = new PerspectiveCamera(46, viewport.clientWidth / viewport.clientHeight, 0.01, 10_000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.screenSpacePanning = true;
controls.zoomToCursor = true;
controls.minDistance = 0.05;
controls.mouseButtons.LEFT = 0;
controls.mouseButtons.RIGHT = 2;

scene.add(new HemisphereLight(0xc9f6ef, 0x102025, 1.7));
scene.add(new AmbientLight(0xffffff, 1.05));
const sun = new DirectionalLight(0xffffff, 1.1);
sun.position.set(-3, -4, 8);
scene.add(sun);

const raycaster = new Raycaster();
const pointer = new Vector2();
const frustum = new Frustum();
const projectionMatrix = new Matrix4();
let manifest!: DatasetManifest;
let datasetLoaded = false;
let model: Group | undefined;
let textureStreamer: TextureStreamer | undefined;
let detailTileOverlay: DetailTileOverlay | undefined;
let pinnedMaterials = new Set<string>();
let qualityMode: QualityMode = "auto";
let interactionMode: InteractionMode = "navigate";
let wireframe = false;
let measurementPoints: Vector3[] = [];
let measurementLine: Line | undefined;
let calibrationReferences: CalibrationReference[] = [];
let pendingCalibrationDistance = 0;
let selectionStart: { x: number; y: number } | undefined;
let lastPlanTime = 0;
let detailTextureBytes = 0;
let latestStreamingStatus: StreamingStatus | undefined;
let latestDetailStatus: DetailOverlayStatus | undefined;
let cacheRefreshTimer: number | undefined;
let automaticDetailTimer: number | undefined;
let controlsInteracting = false;
let activeTextureBudgets: TextureBudgets = textureBudgets(
  Number(localStorage.getItem(textureBudgetStorageKey) ?? DEFAULT_TEXTURE_BUDGET_MIB),
);

function updateTextureBudgetLabel(valueMiB: number): void {
  const label = formatBudgetGiB(textureBudgets(valueMiB).totalMiB);
  textureBudgetOutput.textContent = label;
  textureBudgetInput.setAttribute("aria-valuetext", label);
}

textureBudgetInput.value = String(activeTextureBudgets.totalMiB);
updateTextureBudgetLabel(activeTextureBudgets.totalMiB);

function renderStreamingStatus(): void {
  const presentation = streamingStatusPresentation(latestStreamingStatus, latestDetailStatus);
  streamStatus.textContent = presentation.message;
  statusDot.classList.toggle("busy", presentation.busy);
  if (!latestStreamingStatus) return;
  fullCount.textContent = String(latestStreamingStatus.fullCount);
  mediumCount.textContent = String(latestStreamingStatus.mediumCount);
  memoryCount.textContent = String(Math.round((latestStreamingStatus.dynamicBytes + detailTextureBytes) / MiB));
}

function updateStreamingStatus(status: StreamingStatus): void {
  latestStreamingStatus = status;
  renderStreamingStatus();
}

function updateDetailStatus(status: DetailOverlayStatus): void {
  latestDetailStatus = status;
  const previousDetailTextureBytes = detailTextureBytes;
  detailTextureBytes = status.estimatedGpuBytes;
  renderStreamingStatus();
  const automatic = status.source === "automatic";
  if (status.phase === "idle") {
    showIdleDetailStatus();
  } else if (status.phase === "analyzing") {
    areaStatus.textContent = automatic ? "Checking visible source detail…" : "Finding every visible texture tile…";
  } else if (status.phase === "limited") {
    areaStatus.textContent = automatic
      ? status.loadedTiles > 0
        ? "New view exceeds the GPU limit · keeping loaded source tiles"
        : "Visible source detail exceeds the GPU limit · using streamed textures"
      : status.message ?? "Draw a smaller box for complete detail";
  } else if (status.phase === "error") {
    areaStatus.textContent = automatic
      ? "Automatic source detail unavailable · using streamed textures"
      : status.message ?? "Detail tiles could not be loaded";
  }
  else {
    const coverage = Math.round(status.coverage * 100);
    const progress = `${status.loadedTiles}/${status.requestedTiles} full-res tiles`;
    areaStatus.textContent = status.phase === "ready"
      ? `${automatic ? "Auto · " : ""}${progress} · ${coverage}% of ${automatic ? "visible" : "selected"} pixels covered`
      : `${automatic ? "Auto · " : ""}${progress} · ${status.materialCount} texture sections`;
  }
  if (detailTextureBytes !== previousDetailTextureBytes || (status.phase !== "loading" && status.phase !== "ready")) {
    updateTexturePlan(true);
  }
  if (status.phase === "ready" || status.phase === "error") void refreshDetailCache();
}

function showIdleDetailStatus(): void {
  areaStatus.textContent = qualityMode === "detail" ? "Auto source detail follows the camera" : "No detail area pinned";
}

function formatDiskBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${Math.round(bytes / MiB)} MiB`;
}

function updateDetailCacheLimitLabel(valueGiB: number): void {
  const label = `${valueGiB.toFixed(1)} GiB`;
  detailCacheLimitOutput.textContent = label;
  detailCacheLimit.setAttribute("aria-valuetext", label);
}

function displayDetailCache(status: DetailCacheStatus): void {
  const current = datasetLoaded ? status.datasets.find((item) => item.id === manifest.id) : undefined;
  const modelBytes = current?.bytes ?? 0;
  detailCacheStatus.textContent = `${formatDiskBytes(status.usedBytes)} of ${formatDiskBytes(status.limitBytes)} used · this model ${formatDiskBytes(modelBytes)}` +
    (status.pendingRemoval ? ` · ${status.pendingRemoval} tile${status.pendingRemoval === 1 ? "" : "s"} clearing` : "");
  const limitGiB = status.limitBytes / 1024 ** 3;
  detailCacheLimit.value = String(limitGiB);
  updateDetailCacheLimitLabel(limitGiB);
  clearModelCache.disabled = !datasetLoaded || modelBytes === 0;
  clearAllCache.disabled = status.usedBytes === 0;
  if (cacheRefreshTimer !== undefined) window.clearTimeout(cacheRefreshTimer);
  if (status.pendingRemoval > 0) cacheRefreshTimer = window.setTimeout(() => void refreshDetailCache(), 2000);
  else cacheRefreshTimer = undefined;
}

async function detailCacheRequest(url: string, init?: RequestInit): Promise<DetailCacheStatus> {
  const response = await fetch(url, init);
  return readDetailCacheResponse(response);
}

async function refreshDetailCache(): Promise<void> {
  try {
    displayDetailCache(await detailCacheRequest("/api/detail-cache"));
  } catch (error) {
    detailCacheStatus.textContent = error instanceof Error ? error.message : "Could not read detail cache";
  }
}

function localCenter(asset: MaterialAsset): Vector3 {
  return new Vector3(
    (asset.bounds.min[0] + asset.bounds.max[0]) / 2 - manifest.center[0],
    (asset.bounds.min[1] + asset.bounds.max[1]) / 2 - manifest.center[1],
    (asset.bounds.min[2] + asset.bounds.max[2]) / 2 - manifest.center[2],
  );
}

function materialViews(): MaterialView[] {
  camera.updateMatrixWorld();
  projectionMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projectionMatrix);
  return manifest.materials.map((material) => {
    const center = localCenter(material);
    const radius = new Vector3(
      material.bounds.max[0] - material.bounds.min[0],
      material.bounds.max[1] - material.bounds.min[1],
      material.bounds.max[2] - material.bounds.min[2],
    ).length() / 2;
    const sphere = new Sphere(center, radius);
    const distance = Math.max(0.001, camera.position.distanceTo(center) - radius);
    return {
      material,
      visible: frustum.intersectsSphere(sphere),
      projectedPixels: projectedPixelDiameter(radius, distance, camera.fov * Math.PI / 180, viewport.clientHeight),
      selected: pinnedMaterials.has(material.name),
    };
  });
}

function updateTexturePlan(force = false): void {
  if (!datasetLoaded || !textureStreamer) return;
  const now = performance.now();
  if (!force && now - lastPlanTime < 420) return;
  lastPlanTime = now;
  const budget = detailTileOverlay?.isActive()
    ? activeTextureBudgets.backgroundBytes
    : activeTextureBudgets.normalBytes;
  textureStreamer.apply(planTextureTiers(materialViews(), qualityMode, budget));
}

function cancelAutomaticDetailTimer(): void {
  if (automaticDetailTimer !== undefined) window.clearTimeout(automaticDetailTimer);
  automaticDetailTimer = undefined;
}

async function refreshAutomaticDetail(): Promise<void> {
  automaticDetailTimer = undefined;
  if (!datasetLoaded || qualityMode !== "detail" || !textureStreamer || !detailTileOverlay || detailTileOverlay.isManual()) return;
  const views = materialViews();
  const wholeTexturePlan = planTextureTiers(views, qualityMode, activeTextureBudgets.normalBytes);
  const completeSourceSetLoaded = wholeTexturePlan.fullCount === manifest.materials.length;
  const automaticAlreadyActive = detailTileOverlay.isAutomatic();
  if (completeSourceSetLoaded || (!automaticAlreadyActive && !needsAutomaticDetail(views, wholeTexturePlan, qualityMode))) {
    if (detailTileOverlay.isAutomatic()) detailTileOverlay.clear();
    textureStreamer.apply(wholeTexturePlan);
    showIdleDetailStatus();
    return;
  }
  await detailTileOverlay.show({
    left: 0,
    top: 0,
    right: renderer.domElement.clientWidth,
    bottom: renderer.domElement.clientHeight,
  }, "automatic");
}

function scheduleAutomaticDetail(): void {
  cancelAutomaticDetailTimer();
  if (!datasetLoaded || qualityMode !== "detail" || detailTileOverlay?.isManual()) return;
  automaticDetailTimer = window.setTimeout(() => void refreshAutomaticDetail(), AUTOMATIC_DETAIL_SETTLE_MS);
}

function setPerspectiveView(): void {
  if (!datasetLoaded) return;
  const size = Math.max(...manifest.extent);
  camera.up.set(0, 0, 1);
  camera.position.set(size * 0.72, -size * 0.92, size * 0.72);
  camera.near = Math.max(size / 50_000, 0.001);
  camera.far = size * 50;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
  updateTexturePlan(true);
  scheduleAutomaticDetail();
}

function setTopView(): void {
  if (!datasetLoaded) return;
  const size = Math.max(...manifest.extent);
  camera.up.set(0, 1, 0);
  camera.position.set(0, 0, size * 1.6);
  controls.target.set(0, 0, 0);
  controls.update();
  updateTexturePlan(true);
  scheduleAutomaticDetail();
}

function setPointer(event: MouseEvent): void {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

function hitTest(event: MouseEvent) {
  if (!model) return undefined;
  setPointer(event);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObject(model, true)[0];
}

function materialNameForHit(hit: ReturnType<Raycaster["intersectObject"]>[number]): string | undefined {
  const mesh = hit.object as Mesh;
  if (Array.isArray(mesh.material)) return mesh.material[hit.face?.materialIndex ?? 0]?.name;
  return mesh.material?.name;
}

function clearMeasurementLine(): void {
  measurementPoints = [];
  if (measurementLine) scene.remove(measurementLine);
  measurementLine?.geometry.dispose();
  measurementLine = undefined;
}

function drawMeasurementLine(): number {
  const distance = measurementPoints[0]!.distanceTo(measurementPoints[1]!);
  const geometry = new BufferGeometry().setAttribute(
    "position", new Float32BufferAttribute(measurementPoints.flatMap((point) => point.toArray()), 3),
  );
  measurementLine = new Line(geometry, new LineBasicMaterial({ color: 0x7af0d0, depthTest: false }));
  measurementLine.renderOrder = 10;
  scene.add(measurementLine);
  return distance;
}

function setInteractionMode(next: InteractionMode): void {
  interactionMode = interactionMode === next ? "navigate" : next;
  element("measure").setAttribute("aria-pressed", String(interactionMode === "measure"));
  element("calibrate").setAttribute("aria-pressed", String(interactionMode === "calibrate"));
  element("select-area").setAttribute("aria-pressed", String(interactionMode === "select-area"));
  controls.enabled = interactionMode !== "select-area";
  measureReadout.classList.toggle("hidden", interactionMode !== "measure" && interactionMode !== "calibrate");
  if (interactionMode === "measure") measureReadout.textContent = "Measure · click two surface points";
  if (interactionMode === "calibrate") measureReadout.textContent = "Calibration · click both ends of a known length";
  if (interactionMode === "select-area") areaStatus.textContent = "Drag a rectangle over the reef";
  renderer.domElement.style.cursor = interactionMode === "navigate" ? "grab" : "crosshair";
  clearMeasurementLine();
}

function focusAt(event: MouseEvent): void {
  if (interactionMode !== "navigate") return;
  const hit = hitTest(event);
  if (!hit) return;
  const materialName = materialNameForHit(hit);
  detailTileOverlay?.clear();
  pinnedMaterials = materialName ? new Set([materialName]) : new Set();
  controls.target.copy(hit.point);
  const direction = camera.position.clone().sub(hit.point).normalize();
  const currentDistance = camera.position.distanceTo(hit.point);
  const preferredDistance = Math.min(currentDistance, Math.max(...manifest.extent) * 0.16);
  camera.position.copy(hit.point).addScaledVector(direction, preferredDistance);
  controls.update();
  updateTexturePlan(true);
  scheduleAutomaticDetail();
}

function addPoint(event: MouseEvent): void {
  if (interactionMode !== "measure" && interactionMode !== "calibrate") return;
  const hit = hitTest(event);
  if (!hit) return;
  if (measurementPoints.length >= 2) clearMeasurementLine();
  measurementPoints.push(hit.point.clone());
  if (measurementPoints.length === 1) {
    measureReadout.textContent = "Choose the second point";
    return;
  }
  const rawDistance = drawMeasurementLine();
  if (interactionMode === "measure") {
    measureReadout.textContent = formatMeasuredDistance(rawDistance, fitScale(calibrationReferences));
  } else {
    pendingCalibrationDistance = rawDistance;
    rawReferenceDistance.textContent = rawDistance.toFixed(4);
    knownLength.value = "";
    calibrationDialog.showModal();
    setInteractionMode("navigate");
  }
}

function calibrationStorageKey(): string { return `reefstream:calibration:${manifest.id}`; }
function updateCalibrationSummary(): void {
  const scale = fitScale(calibrationReferences);
  calibrationStatus.textContent = scale
    ? `${calibrationReferences.length} ref${calibrationReferences.length === 1 ? "" : "s"} · 1 unit = ${scale.toPrecision(5)} m`
    : "Uncalibrated · model units";
}
function saveCalibration(): void {
  localStorage.setItem(calibrationStorageKey(), JSON.stringify(calibrationReferences));
  updateCalibrationSummary();
}
function loadCalibration(): void {
  try { calibrationReferences = JSON.parse(localStorage.getItem(calibrationStorageKey()) ?? "[]") as CalibrationReference[]; }
  catch { calibrationReferences = []; }
  updateCalibrationSummary();
}

function selectionCoordinates(event: PointerEvent): { x: number; y: number } {
  const rect = renderer.domElement.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
function updateSelectionElement(rect: ScreenRect): void {
  selectionRectElement.classList.remove("hidden");
  selectionRectElement.style.left = `${rect.left}px`;
  selectionRectElement.style.top = `${rect.top}px`;
  selectionRectElement.style.width = `${rect.right - rect.left}px`;
  selectionRectElement.style.height = `${rect.bottom - rect.top}px`;
}
function beginAreaSelection(event: PointerEvent): void {
  if (interactionMode !== "select-area") return;
  selectionStart = selectionCoordinates(event);
  updateSelectionElement(normalizedRect(selectionStart.x, selectionStart.y, selectionStart.x, selectionStart.y));
  renderer.domElement.setPointerCapture(event.pointerId);
}
function moveAreaSelection(event: PointerEvent): void {
  if (!selectionStart || interactionMode !== "select-area") return;
  const end = selectionCoordinates(event);
  updateSelectionElement(normalizedRect(selectionStart.x, selectionStart.y, end.x, end.y));
}
function finishAreaSelection(event: PointerEvent): void {
  if (!selectionStart || interactionMode !== "select-area") return;
  const end = selectionCoordinates(event);
  const selection = normalizedRect(selectionStart.x, selectionStart.y, end.x, end.y);
  selectionStart = undefined;
  selectionRectElement.classList.add("hidden");
  pinnedMaterials.clear();
  areaStatus.textContent = "Finding every visible texture tile…";
  setInteractionMode("navigate");
  updateTexturePlan(true);
  cancelAutomaticDetailTimer();
  void detailTileOverlay?.show(selection, "manual");
}

async function fetchDatasets(): Promise<DatasetSummary[]> {
  return fetch("/api/datasets").then(async (response) => response.json() as Promise<DatasetSummary[]>);
}
async function loadDataset(): Promise<void> {
  const datasets = await fetchDatasets();
  datasetSwitch.replaceChildren(...datasets.map((dataset) => {
    const option = document.createElement("option");
    option.value = dataset.id;
    option.textContent = dataset.label;
    return option;
  }));
  const requested = new URLSearchParams(location.search).get("dataset");
  const id = datasets.some((dataset) => dataset.id === requested) ? requested! : datasets[0]?.id;
  if (!id) {
    datasetName.textContent = "No model loaded";
    loadingPercent.textContent = "Ready";
    loadingBar.style.width = "0";
    loadingDetail.textContent = "Add a textured OBJ to begin.";
    importDialog.showModal();
    return;
  }
  datasetSwitch.value = id;
  manifest = await fetch(`/dataset/${encodeURIComponent(id)}/manifest.json`).then(async (response) => {
    if (!response.ok) throw new Error(`Cannot load dataset manifest (${response.status})`);
    return response.json() as Promise<DatasetManifest>;
  });
  datasetName.textContent = manifest.label;
  element("triangle-count").textContent = manifest.stats.triangles.toLocaleString();
  element("material-count").textContent = String(manifest.stats.materials);
  element("texture-size").textContent = `${(manifest.stats.sourceTextureBytes / 1024 ** 3).toFixed(2)} GiB`;
  loadCalibration();

  const loader = new GLTFLoader();
  const gltf = await new Promise<Awaited<ReturnType<GLTFLoader["loadAsync"]>>>((resolve, reject) => {
    loader.load(manifest.modelUrl, resolve, (progress) => {
      const percent = progress.total > 0 ? Math.min(99, Math.round(progress.loaded / progress.total * 100)) : 0;
      loadingBar.style.width = `${percent}%`;
      loadingPercent.textContent = `${percent}%`;
      loadingDetail.textContent = `${(progress.loaded / MiB).toFixed(1)} MiB received`;
    }, reject);
  });
  model = gltf.scene;
  model.position.set(-manifest.center[0], -manifest.center[1], -manifest.center[2]);
  scene.add(model);
  textureStreamer = new TextureStreamer(manifest, renderer, updateStreamingStatus);
  model.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) if (material instanceof MeshStandardMaterial) {
      material.envMapIntensity = 0.3;
      textureStreamer?.register(material);
    }
  });
  detailTileOverlay = new DetailTileOverlay(
    scene, model, camera, renderer, manifest, activeTextureBudgets.detailBytes, updateDetailStatus,
  );
  datasetLoaded = true;
  void refreshDetailCache();
  setPerspectiveView();
  loadingBar.style.width = "100%";
  loadingPercent.textContent = "100%";
  loadingDetail.textContent = "Overview ready. Detail follows the camera or a drawn area.";
  setTimeout(() => loading.classList.add("done"), 500);
  updateTexturePlan(true);
}

async function pollPreparation(jobId: string): Promise<void> {
  while (true) {
    const job = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`).then(async (response) => response.json() as Promise<PreparationJob>);
    importBar.style.width = `${job.progress}%`;
    importMessage.textContent = `${job.progress}% · ${job.message}`;
    if (job.status === "complete") {
      location.href = `/?dataset=${encodeURIComponent(job.datasetId)}`;
      return;
    }
    if (job.status === "failed") {
      importProgress.classList.add("hidden");
      throw new Error(job.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

element("home-view").addEventListener("click", setPerspectiveView);
element("top-view").addEventListener("click", setTopView);
element("wireframe").addEventListener("click", (event) => {
  wireframe = !wireframe;
  (event.currentTarget as HTMLButtonElement).setAttribute("aria-pressed", String(wireframe));
  model?.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) if (material instanceof MeshStandardMaterial) material.wireframe = wireframe;
  });
});
element("measure").addEventListener("click", () => setInteractionMode("measure"));
element("calibrate").addEventListener("click", () => setInteractionMode("calibrate"));
element("select-area").addEventListener("click", () => setInteractionMode("select-area"));
element("clear-area").addEventListener("click", () => {
  pinnedMaterials.clear();
  detailTileOverlay?.clear();
  updateTexturePlan(true);
  scheduleAutomaticDetail();
});
element("reset-calibration").addEventListener("click", () => {
  calibrationReferences = [];
  saveCalibration();
  clearMeasurementLine();
});
qualitySelect.addEventListener("change", () => {
  qualityMode = qualitySelect.value as QualityMode;
  if (qualityMode !== "detail" && detailTileOverlay?.isAutomatic()) detailTileOverlay.clear();
  if (!detailTileOverlay?.isActive()) showIdleDetailStatus();
  updateTexturePlan(true);
  scheduleAutomaticDetail();
});
textureBudgetInput.addEventListener("input", () => updateTextureBudgetLabel(textureBudgetInput.valueAsNumber));
textureBudgetInput.addEventListener("change", () => {
  activeTextureBudgets = textureBudgets(textureBudgetInput.valueAsNumber);
  textureBudgetInput.value = String(activeTextureBudgets.totalMiB);
  updateTextureBudgetLabel(activeTextureBudgets.totalMiB);
  localStorage.setItem(textureBudgetStorageKey, String(activeTextureBudgets.totalMiB));
  detailTileOverlay?.setBudgetBytes(activeTextureBudgets.detailBytes);
  if (detailTileOverlay?.isActive()) {
    const manual = detailTileOverlay.isManual();
    detailTileOverlay.clear();
    if (manual) areaStatus.textContent = "Memory changed · redraw the detail area";
  }
  updateTexturePlan(true);
  scheduleAutomaticDetail();
});
detailCacheLimit.addEventListener("input", () => updateDetailCacheLimitLabel(detailCacheLimit.valueAsNumber));
detailCacheLimit.addEventListener("change", async () => {
  detailCacheLimit.disabled = true;
  try {
    displayDetailCache(await detailCacheRequest("/api/detail-cache/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limitGiB: Number(detailCacheLimit.value) }),
    }));
  } catch (error) {
    detailCacheStatus.textContent = error instanceof Error ? error.message : "Could not change cache limit";
    void refreshDetailCache();
  } finally {
    detailCacheLimit.disabled = false;
  }
});
clearModelCache.addEventListener("click", async () => {
  if (!datasetLoaded || !window.confirm(`Clear generated detail tiles for ${manifest.label}?`)) return;
  clearModelCache.disabled = true;
  try {
    displayDetailCache(await detailCacheRequest(`/api/detail-cache/${encodeURIComponent(manifest.id)}`, { method: "DELETE" }));
  } catch (error) {
    detailCacheStatus.textContent = error instanceof Error ? error.message : "Could not clear model tiles";
  } finally {
    void refreshDetailCache();
  }
});
clearAllCache.addEventListener("click", async () => {
  if (!window.confirm("Clear generated detail tiles for all models?")) return;
  clearAllCache.disabled = true;
  try {
    displayDetailCache(await detailCacheRequest("/api/detail-cache", { method: "DELETE" }));
  } catch (error) {
    detailCacheStatus.textContent = error instanceof Error ? error.message : "Could not clear detail tiles";
  } finally {
    void refreshDetailCache();
  }
});
panelToggle.addEventListener("click", () => {
  const closed = controlPanel?.classList.toggle("closed") ?? false;
  panelToggle.setAttribute("aria-pressed", String(closed));
  panelToggle.textContent = closed ? "Controls" : "Hide controls";
});
datasetSwitch.addEventListener("change", () => { location.href = `/?dataset=${encodeURIComponent(datasetSwitch.value)}`; });

calibrationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = knownLength.valueAsNumber;
  if (!Number.isFinite(value) || value <= 0 || pendingCalibrationDistance <= 0) return;
  calibrationReferences.push({ id: crypto.randomUUID(), rawDistance: pendingCalibrationDistance, knownValue: value, unit: knownUnit.value as LengthUnit });
  saveCalibration();
  calibrationDialog.close();
});
element("cancel-calibration").addEventListener("click", () => calibrationDialog.close());

element("add-model").addEventListener("click", () => {
  clearImportError();
  importProgress.classList.add("hidden");
  importDialog.showModal();
});
element("cancel-import").addEventListener("click", () => importDialog.close());
element("browse-model").addEventListener("click", async () => {
  const button = element<HTMLButtonElement>("browse-model");
  button.disabled = true;
  button.textContent = "Opening…";
  try {
    const result = await fetch("/api/pick-model", { method: "POST" }).then(async (response) => response.json() as Promise<{ path: string | null; error?: string }>);
    if (result.error) throw new Error(result.error);
    if (result.path) {
      modelPathInput.value = result.path;
      if (!modelLabelInput.value) modelLabelInput.value = result.path.split(/[\\/]/).at(-1)?.replace(/\.obj$/i, "").replace(/[_-]+/g, " ") ?? "";
    }
  } catch (error) {
    showImportError(error);
  } finally {
    button.disabled = false;
    button.textContent = "Browse…";
  }
});
importForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearImportError();
  importProgress.classList.remove("hidden");
  startImportButton.disabled = true;
  startImportButton.textContent = "Converting…";
  try {
    const response = await fetch("/api/prepare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: modelPathInput.value, label: modelLabelInput.value }),
    });
    const result = await response.json() as PreparationJob & { error?: string };
    if (!response.ok || result.error) throw new Error(result.error ?? "Conversion could not start.");
    await pollPreparation(result.id);
  } catch (error) {
    showImportError(error);
    startImportButton.disabled = false;
    startImportButton.textContent = "Convert and open";
  }
});

renderer.domElement.addEventListener("dblclick", focusAt);
renderer.domElement.addEventListener("click", addPoint);
renderer.domElement.addEventListener("pointerdown", beginAreaSelection);
renderer.domElement.addEventListener("pointermove", moveAreaSelection);
renderer.domElement.addEventListener("pointerup", finishAreaSelection);
controls.addEventListener("start", () => {
  controlsInteracting = true;
  cancelAutomaticDetailTimer();
});
controls.addEventListener("end", () => {
  controlsInteracting = false;
  scheduleAutomaticDetail();
});
controls.addEventListener("change", () => {
  updateTexturePlan();
  if (!controlsInteracting) scheduleAutomaticDetail();
});
window.addEventListener("resize", () => {
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  updateTexturePlan(true);
  scheduleAutomaticDetail();
});

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

void refreshDetailCache();

loadDataset().catch((error: unknown) => {
  console.error(error);
  loadingPercent.textContent = "Error";
  loadingBar.style.width = "100%";
  loadingBar.style.background = "#ef7b73";
  loadingDetail.textContent = error instanceof Error ? error.message : String(error);
  streamStatus.textContent = "Dataset unavailable";
  statusDot.classList.add("busy");
});

window.addEventListener("beforeunload", () => {
  cancelAutomaticDetailTimer();
  detailTileOverlay?.dispose();
  textureStreamer?.dispose();
});
