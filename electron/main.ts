// Electron main process (trusted): the only process that holds the decrypted
// vault and canonical values (RFC-002 §2.1 / §3). It owns the SoroeruSession,
// registers exactly the allowlisted IPC channels, and creates the renderer
// window with strict isolation. The renderer reaches the vault solely through
// these typed channels, never directly.

import { app, BrowserWindow, ipcMain, shell } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { SoroeruSession } from "./session.js";
import { createChromeExtensionBridge } from "./chrome-extension-bridge-runtime.js";
import { createIpcBridge } from "./ipc/bridge.js";
import { CHROME_BRIDGE_EVENT_CHANNEL, VISIBILITY_EVENT_CHANNEL } from "./ipc/contract.js";
import { registerCrashLogging } from "./crash-logging.js";
import { defaultNativeHostPaths } from "../native-host/registration.js";
import { ChromeBridgeSettingsStore } from "./chrome-bridge-settings.js";

// Product name (issue #158): the userData path becomes
// ".../Application Support/Soroeru". The code identifier stays "soroeru".
app.setName("Soroeru");

const here = dirname(fileURLToPath(import.meta.url));
// dist/compiled/electron -> repo/app root (three levels up). In a packaged app
// the same relative layout holds under the app resources directory.
const appRoot = resolve(here, "..", "..", "..");

const DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const PRELOAD_PATH = join(appRoot, "dist", "preload", "preload.cjs");
const RENDERER_INDEX = join(appRoot, "dist", "renderer", "index.html");
// Packaged builds bundle the self-contained host at Resources/native-host/
// (forge.config.cjs extraResource); dev builds use the `build:host` output at
// dist/native-host/ (built by `npm run dev`), so native-host registration
// works identically without SOROERU_CHROME_BRIDGE_HOST_BINARY. The env var
// remains as an explicit override for both modes.
const CHROME_HOST_BINARY =
  process.env["SOROERU_CHROME_BRIDGE_HOST_BINARY"] ??
  (app.isPackaged
    ? join(process.resourcesPath, "native-host", "host.cjs")
    : join(appRoot, "dist", "native-host", "host.cjs"));

function configurePackagedPlaywrightBrowsers(): void {
  if (!app.isPackaged || process.env["PLAYWRIGHT_BROWSERS_PATH"]) return;
  const bundledBrowsers = join(appRoot, "node_modules", "playwright-core", ".local-browsers");
  process.env["PLAYWRIGHT_BROWSERS_PATH"] = bundledBrowsers;
}

/**
 * Resolve the vault file path. Honors the existing `SOROERU_STATE_ROOT`
 * override; otherwise uses Electron's per-app userData directory
 * (".../Application Support/Soroeru"), keeping it consistent with `app.getPath`.
 */
function resolveVaultPath(): string {
  const override = process.env["SOROERU_STATE_ROOT"];
  const stateRoot = override && override.length > 0 ? override : app.getPath("userData");
  return join(stateRoot, "vault.json");
}

function registerIpc(session: SoroeruSession): void {
  const bridge = createIpcBridge(session);
  for (const [channel, handler] of Object.entries(bridge)) {
    // Only channels present in the bridge (the contract allowlist) are handled.
    ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(...args));
  }
}

async function createWindow(session: SoroeruSession): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    show: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      // Trust boundary (RFC-002 §3, issue #158 Verification): the renderer is an
      // untrusted UI surface. It gets no Node, an isolated context, and a
      // sandboxed process; capabilities arrive only via the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Forward Visibility run progress / wall hand-off events to this window. The
  // payload is sanitized (counts / references / masked wording) by the service.
  session.setVisibilityEventSink((event) => {
    if (!window.isDestroyed()) window.webContents.send(VISIBILITY_EVENT_CHANNEL, event);
  });

  if (DEV_SERVER_URL) {
    await window.loadURL(DEV_SERVER_URL);
  } else {
    await window.loadFile(RENDERER_INDEX);
  }
  return window;
}

async function main(): Promise<void> {
  await app.whenReady();
  configurePackagedPlaywrightBrowsers();

  const vaultPath = resolveVaultPath();
  await mkdir(dirname(vaultPath), { recursive: true });
  const chromeBridgeSettingsStore = new ChromeBridgeSettingsStore(
    join(app.getPath("userData"), "chrome-bridge-settings.json"),
  );
  const chromeBridgeSettings = await chromeBridgeSettingsStore.resolve(process.env);
  // eslint-disable-next-line prefer-const
  let session: SoroeruSession | undefined;
  const chromeBridge = createChromeExtensionBridge({
    enabled: chromeBridgeSettings.effective.enabled,
    appSupportDir: app.getPath("userData"),
    socketPath: join(app.getPath("userData"), "native-host", "bridge.sock"),
    onEvent: (event) => {
      if (session) {
        session.log("info", "chrome-bridge", `connection state transition: ${event.type}`, {
          ...(event.type === "rejected" ? { reason: event.reason } : {}),
        });
      } else {
        console.log(`[chrome-bridge] connection state transition: ${event.type}`);
      }
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(CHROME_BRIDGE_EVENT_CHANNEL, event);
      }
    },
  });
  if (chromeBridge) await chromeBridge.start();
  session = new SoroeruSession(vaultPath, {
    // egress: target-site — user-initiated handoff to the user's default browser for manual saved-page import.
    openExternal: (url) => shell.openExternal(url),
    // Developer-only extension automation path (Issue #338); selected when
    // SOROERU_CHROME_BRIDGE_TAB_ID is set. Playwright remains the default.
    ...(chromeBridge ? { chromeBridge } : {}),
    ...(chromeBridge && chromeBridgeSettings.effective.extensionId && CHROME_HOST_BINARY
      ? {
          chromeBridgeSetup: {
            sourceBinary: CHROME_HOST_BINARY,
            extensionId: chromeBridgeSettings.effective.extensionId,
            paths: defaultNativeHostPaths(),
          },
        }
      : {}),
    chromeBridgeSettings: {
      initial: chromeBridgeSettings,
      save: (input) => chromeBridgeSettingsStore.save(input),
    },
  });
  registerCrashLogging(session);
  session.log("info", "app", "app started", { version: app.getVersion(), platform: process.platform });
  registerIpc(session);

  await createWindow(session);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow(session);
  });

  // Orderly teardown (RFC-002 §5.2): close every Playwright session + the
  // browser and lock the vault before the process exits, so quit leaves no
  // orphan browser process and no derived key in memory. `before-quit` is
  // async-safe: prevent the default once, run shutdown, then quit for real.
  let shuttingDown = false;
  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    void Promise.all([session.shutdown(), chromeBridge?.close()])
      .catch(() => {
        // Teardown is best-effort; never block the quit on a wedged browser.
      })
      .finally(() => app.quit());
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void main();
