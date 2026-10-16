// Which host the shared renderer components run in (Issue #569). Electron keeps
// the defaults; the extension Side Panel turns off controls that only the
// Electron automation path can honor (Playwright storageState persistence, the
// Electron-to-extension developer bridge).

export interface SurfaceCapabilities {
  /** Per-site opt-in login session persistence (Issue #294, Playwright storageState). */
  sessionPersistence: boolean;
  /** Developer-only Electron-to-extension bridge settings (Issue #338). */
  chromeBridge: boolean;
}

let capabilities: SurfaceCapabilities = { sessionPersistence: true, chromeBridge: true };

/** Called once by the host before rendering. */
export function configureSurface(next: Partial<SurfaceCapabilities>): void {
  capabilities = { ...capabilities, ...next };
}

export function surfaceCapabilities(): Readonly<SurfaceCapabilities> {
  return capabilities;
}
