// Electron main process (trusted): the only process that holds the decrypted
// vault and canonical values (RFC-002 §2.1 / §3). It owns the SoroeruSession,
// registers exactly the allowlisted IPC channels, and creates the renderer
// window with strict isolation. The renderer reaches the vault solely through
// these typed channels, never directly.

import { app, BrowserWindow, ipcMain } from "electron";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { SoroeruSession } from "./session.js";
import { createIpcBridge } from "./ipc/bridge.js";

// Product name (issue #158): the userData path becomes
// ".../Application Support/Soroeru". The code identifier stays "catashiro".
app.setName("Soroeru");

const here = dirname(fileURLToPath(import.meta.url));
// dist/compiled/electron -> repo/app root (three levels up). In a packaged app
// the same relative layout holds under the app resources directory.
const appRoot = resolve(here, "..", "..", "..");

const DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
const PRELOAD_PATH = join(appRoot, "dist", "preload", "preload.cjs");
const RENDERER_INDEX = join(appRoot, "dist", "renderer", "index.html");

function configurePackagedPlaywrightBrowsers(): void {
  if (!app.isPackaged || process.env["PLAYWRIGHT_BROWSERS_PATH"]) return;
  const bundledBrowsers = join(appRoot, "node_modules", "playwright-core", ".local-browsers");
  process.env["PLAYWRIGHT_BROWSERS_PATH"] = bundledBrowsers;
}

/**
 * Resolve the vault file path. Honors the existing `CATASHIRO_STATE_ROOT`
 * override; otherwise uses Electron's per-app userData directory
 * (".../Application Support/Soroeru"), keeping it consistent with `app.getPath`.
 */
function resolveVaultPath(): string {
  const override = process.env["CATASHIRO_STATE_ROOT"];
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

async function createWindow(): Promise<void> {
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

  if (DEV_SERVER_URL) {
    await window.loadURL(DEV_SERVER_URL);
  } else {
    await window.loadFile(RENDERER_INDEX);
  }
}

async function main(): Promise<void> {
  await app.whenReady();
  configurePackagedPlaywrightBrowsers();

  const vaultPath = resolveVaultPath();
  await mkdir(dirname(vaultPath), { recursive: true });
  const session = new SoroeruSession(vaultPath);
  registerIpc(session);

  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

void main();
