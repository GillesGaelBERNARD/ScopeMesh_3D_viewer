import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4173";
const preparationReportPath = resolve(process.argv[3] ?? "test-results/corpus-smoke-2026-09-22.json");
const browserReportPath = resolve(process.argv[4] ?? "test-results/browser-corpus-smoke-2026-09-22.json");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = await mkdtemp(join(tmpdir(), "reefstream-chrome-"));
const preparation = JSON.parse(await readFile(preparationReportPath, "utf8"));
const results = [];
let chrome;
let cdp;

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function waitForDevTools() {
  const portFile = join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [port] = (await readFile(portFile, "utf8")).trim().split(/\r?\n/);
      if (port) return Number(port);
    } catch {
      // Chrome has not written its debugging endpoint yet.
    }
    await delay(100);
  }
  throw new Error("Chrome DevTools endpoint did not start.");
}

class CdpClient {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("Cannot connect to Chrome DevTools.")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, reject) => this.pending.set(id, { resolve: resolveSend, reject }));
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  close() {
    this.socket.close();
  }
}

async function saveReport(startedAt) {
  await writeFile(browserReportPath, `${JSON.stringify({
    preparationReportPath,
    startedAt,
    updatedAt: new Date().toISOString(),
    expectedCount: preparation.objectCount,
    passedCount: results.filter((result) => result.status === "complete").length,
    failedCount: results.filter((result) => result.status === "failed").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
    results,
  }, null, 2)}\n`, "utf8");
}

const startedAt = new Date().toISOString();
try {
  chrome = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-extensions",
    "--disable-background-networking",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--window-size=1280,900",
    "about:blank",
  ], { windowsHide: true, stdio: "ignore" });
  const port = await waitForDevTools();
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = pages.find((candidate) => candidate.type === "page");
  if (!page?.webSocketDebuggerUrl) throw new Error("Chrome did not expose a page target.");
  cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.open();
  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Network.enable"),
    cdp.send("Log.enable"),
  ]);

  let activeErrors = [];
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    activeErrors.push(`Exception: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  });
  cdp.on("Log.entryAdded", ({ entry }) => {
    if (entry.level === "error") activeErrors.push(`Console: ${entry.text}`);
  });
  cdp.on("Network.loadingFailed", ({ errorText, canceled }) => {
    if (!canceled) activeErrors.push(`Network: ${errorText}`);
  });
  cdp.on("Network.responseReceived", ({ response }) => {
    if (response.status >= 400) activeErrors.push(`HTTP ${response.status}: ${response.url}`);
  });

  for (const prepared of preparation.results) {
    const label = `[${prepared.ordinal}/${preparation.objectCount}]`;
    if (prepared.status !== "complete") {
      results.push({ ordinal: prepared.ordinal, path: prepared.path, datasetId: prepared.datasetId, status: "skipped", error: prepared.error });
      console.log(`${label} SKIP preparation failed`);
      await saveReport(startedAt);
      continue;
    }

    activeErrors = [];
    const started = Date.now();
    console.log(`${label} OPEN ${prepared.datasetId}`);
    try {
      await cdp.send("Page.navigate", { url: `${baseUrl}/?dataset=${encodeURIComponent(prepared.datasetId)}` });
      let state;
      for (let attempt = 0; attempt < 180; attempt += 1) {
        await delay(500);
        const evaluation = await cdp.send("Runtime.evaluate", {
          expression: `(() => ({
            readyState: document.readyState,
            name: document.getElementById("dataset-name")?.textContent,
            percent: document.getElementById("loading-percent")?.textContent,
            detail: document.getElementById("loading-detail")?.textContent,
            triangles: document.getElementById("triangle-count")?.textContent,
            materials: document.getElementById("material-count")?.textContent,
            canvasCount: document.querySelectorAll("canvas").length,
            canvasWidth: document.querySelector("canvas")?.width ?? 0,
            canvasHeight: document.querySelector("canvas")?.height ?? 0,
            contextLost: document.querySelector("canvas")?.getContext("webgl2")?.isContextLost() ?? true
          }))()`,
          returnByValue: true,
        });
        state = evaluation.result.value;
        if (state?.percent === "Error") throw new Error(state.detail ?? "Viewer reported an error.");
        if (state?.detail?.startsWith("Overview ready.")) break;
      }
      if (!state?.detail?.startsWith("Overview ready.")) throw new Error(`Viewer did not become ready: ${state?.detail ?? "no status"}`);
      if (state.canvasCount !== 1 || state.canvasWidth < 1 || state.canvasHeight < 1 || state.contextLost) {
        throw new Error(`Invalid WebGL canvas state: ${JSON.stringify(state)}`);
      }
      await cdp.send("Runtime.evaluate", {
        expression: `document.getElementById("top-view").click(); document.getElementById("wireframe").click(); document.getElementById("home-view").click();`,
      });
      await delay(250);
      if (activeErrors.length) throw new Error([...new Set(activeErrors)].join(" | "));
      results.push({
        ordinal: prepared.ordinal,
        path: prepared.path,
        datasetId: prepared.datasetId,
        status: "complete",
        elapsedSeconds: Math.round((Date.now() - started) / 10) / 100,
        state,
        error: null,
      });
      console.log(`${label} PASS ${prepared.datasetId} (${state.triangles} triangles, ${state.materials} materials)`);
    } catch (error) {
      results.push({
        ordinal: prepared.ordinal,
        path: prepared.path,
        datasetId: prepared.datasetId,
        status: "failed",
        elapsedSeconds: Math.round((Date.now() - started) / 10) / 100,
        error: error instanceof Error ? error.message : String(error),
      });
      console.log(`${label} FAIL ${prepared.datasetId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await saveReport(startedAt);
  }
} finally {
  await saveReport(startedAt);
  try {
    if (cdp) await Promise.race([cdp.send("Browser.close"), delay(5_000)]);
  } catch {
    // The browser may already be closing after a renderer failure.
  }
  cdp?.close();
  if (chrome && chrome.exitCode === null) {
    chrome.kill();
    await Promise.race([
      new Promise((resolveExit) => chrome.once("exit", resolveExit)),
      delay(5_000),
    ]);
  }
  const temporaryRoot = resolve(tmpdir());
  const resolvedProfile = resolve(profile);
  if (resolvedProfile.startsWith(`${temporaryRoot}${sep}`)) {
    await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const failed = results.filter((result) => result.status !== "complete").length;
console.log(`BROWSER RESULT: ${results.length - failed} passed, ${failed} failed/skipped, ${results.length} total`);
if (failed) process.exitCode = 1;
