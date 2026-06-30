// Shared test client for the local web UI (`startWebUiServer`).
//
// Several web-UI test files (`soroeru-poc-web-ui`, `-add-site`,
// `-chrome-csv-importer`, `-task-progress`, `-registration`) each used to
// redefine the same `getHtml`/`csrf`/`post`/`unlockThroughUi` helpers. They are
// consolidated here so the per-file setup stays focused on the behavior under
// test. These talk to a real in-process server (a managed dependency), so the
// client uses real `fetch`, not mocks.

import assert from "node:assert/strict";
import type { WebUiServerHandle } from "../../../src/app/web-ui.js";
import { waitFor } from "./wait.js";

/** Passphrase used to unlock the vault in unit tests. Not a real secret. */
export const PASSPHRASE = "unit-test-passphrase";

/** GET `path` and return the response body, asserting a 200. */
export async function getHtml(server: WebUiServerHandle, path = "/"): Promise<string> {
  const res = await fetch(new URL(path, server.url));
  assert.equal(res.status, 200);
  return res.text();
}

/** Extract the CSRF token rendered into a form. */
export function csrf(html: string): string {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, "expected csrf token");
  return match[1]!;
}

/** POST a URL-encoded form, without following redirects. */
export async function post(
  server: WebUiServerHandle,
  path: string,
  body: Record<string, string>,
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: "POST",
    body: new URLSearchParams(body),
    redirect: "manual",
  });
}

/** POST multipart form data (e.g. file uploads), without following redirects. */
export async function postFormData(
  server: WebUiServerHandle,
  path: string,
  body: FormData,
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    method: "POST",
    body,
    redirect: "manual",
  });
}

/** Unlock the vault through the UI and return a usable CSRF token. */
export async function unlockThroughUi(server: WebUiServerHandle): Promise<string> {
  const token = csrf(await getHtml(server));
  const res = await post(server, "/unlock", { csrf: token, passphrase: PASSPHRASE });
  assert.equal(res.status, 303);
  return token;
}

/**
 * Poll the rendered HTML at `path` until `predicate` matches, returning that
 * HTML. Used while a run advances in the background. The default timeout is
 * generous because some callers drive a real headless browser.
 */
export async function pollHtml(
  server: WebUiServerHandle,
  predicate: (html: string) => boolean,
  { path = "/", timeoutMs = 60000 }: { path?: string; timeoutMs?: number } = {},
): Promise<string> {
  return waitFor<string>(
    async () => {
      const html = await getHtml(server, path);
      return predicate(html) ? html : undefined;
    },
    `web UI state at ${path}`,
    { timeoutMs, intervalMs: 100 },
  );
}
