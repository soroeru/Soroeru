import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { build } from "vite";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CloudOperation, CloudRequests, FormSchema } from "../../../src/shared/cloud-contract.js";

export type DemoPage = "tier1" | "tier2" | "tier3" | "wall";
export type CapturedRequest = { operation: CloudOperation; body: CloudRequests[CloudOperation] };

export interface DemoBrowser {
  context: BrowserContext;
  fixture: Page;
  panel: Page;
  requests: CapturedRequest[];
  diagnostics: string[];
  run(): Promise<void>;
  probeFingerprint(): Promise<string>;
  inspect(): Promise<{ status?: string; message?: string; disclosures?: number; cloudEnabled?: boolean }>;
  close(): Promise<void>;
}

const apiOrigin = "https://127.0.0.1:43365";
const siteOrigin = "https://demo.example";
const paths: Record<string, CloudOperation> = {
  "/v1/schemas/resolve": "resolve",
  "/v1/agent/map-structure": "mapStructure",
  "/v1/agent/tier3-ticket": "tier3Ticket",
  "/v1/agent/read-with-consent": "readWithConsent",
  "/v1/schemas/feedback": "feedback",
  "/v1/telemetry/outcome": "outcome",
};

function activeSchema(fingerprint: string): FormSchema {
  return {
    schemaId: fingerprint,
    site: "demo.example",
    formKey: fingerprint,
    version: 1,
    pageFingerprints: [fingerprint],
    fields: [
      { anchor: "f-1", attributeKey: "email", required: true },
      { anchor: "f-2", attributeKey: "phone.full", required: true },
    ],
    confidence: 0.95,
    status: "active",
    provenance: "official",
  };
}

export async function openDemo(page: DemoPage): Promise<DemoBrowser> {
  const dir = await mkdtemp(join(tmpdir(), "soroeru-extension-demo-"));
  const extension = join(dir, "extension");
  let context: BrowserContext | undefined;
  let server: Server | undefined;
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    await promisify(execFile)("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ]);
    await cp(resolve("dist/extension"), extension, { recursive: true });
    // A directly opened extension tab has sender.tab; production accepts only a true Side Panel.
    // Playwright cannot automate Chrome's Side Panel surface, so relax only this sender-shape
    // clause in the disposable worker copy. Extension ID and exact page URL checks remain.
    const workerPath = join(extension, "worker.js");
    const workerSource = await readFile(workerPath, "utf8");
    const senderClause = "||n.tab!==void 0||n.url!==chrome.runtime.getURL(`sidepanel.html`)";
    if (!workerSource.includes(senderClause)) throw new Error("worker sender check changed");
    await writeFile(
      workerPath,
      workerSource.replace(senderClause, "||n.url!==chrome.runtime.getURL(`sidepanel.html`)"),
    );
    const manifestPath = join(extension, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { host_permissions?: string[] };
    manifest.host_permissions = [`${siteOrigin}/*`, "https://*.demo.example/*", `${apiOrigin}/*`];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await build({
      configFile: false,
      logLevel: "silent",
      build: {
        outDir: extension,
        emptyOutDir: false,
        lib: {
          entry: resolve("tests/e2e/helpers/seed-extension-vault.ts"),
          name: "SeedExtensionVault",
          formats: ["iife"],
          fileName: () => "seed-vault.js",
        },
      },
    });
    await writeFile(
      join(extension, "seed-vault.html"),
      '<!doctype html><script src="seed-vault.js"></script>',
    );
    context = await chromium.launchPersistentContext(join(dir, "profile"), {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "--ignore-certificate-errors",
      ],
    });
    const requests: CapturedRequest[] = [];
    const diagnostics: string[] = [];
    context.on("request", (request) => {
      if (request.url().startsWith(apiOrigin)) diagnostics.push(new URL(request.url()).pathname);
    });
    // Use a URL predicate so this catch-all never fires for apiOrigin or siteOrigin,
    // regardless of whether Playwright evaluates routes LIFO or FIFO (the latter
    // applies to Chrome extension service workers).
    await context.route(
      (url) => !url.href.startsWith(apiOrigin) && !url.href.startsWith(siteOrigin),
      (route) => route.abort(),
    );
    await context.route(`${siteOrigin}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname.slice(1);
      if (!/^(tier1|tier2|tier3|wall)$/.test(path)) return route.abort();
      await route.fulfill({ contentType: "text/html", path: resolve(`sites/extension-demo/${path}.html`) });
    });
    const respond = (operation: CloudOperation, body: CloudRequests[CloudOperation]): unknown => {
      requests.push({ operation, body });
      let response: unknown;
      if (operation === "resolve") {
        response =
          page === "tier1"
            ? { schema: activeSchema((body as CloudRequests["resolve"]).pageFingerprint), status: "active" }
            : { schema: null, status: "none" };
      } else if (operation === "mapStructure") {
        const snapshot = body as CloudRequests["mapStructure"];
        const email = snapshot.items.find((item) => item.label === "メールアドレス");
        const phone = snapshot.items.find((item) => item.label === "電話番号");
        const name = snapshot.items.find((item) => item.label === "氏名");
        response = {
          pagePurpose: "profile",
          mappings: [
            ...(email ? [{ itemId: email.id, attributeKey: "email", confidence: 0.95 }] : []),
            ...(page === "tier2" && phone
              ? [{ itemId: phone.id, attributeKey: "phone.full", confidence: 0.95 }]
              : page === "tier3" && name
                ? [{ itemId: name.id, attributeKey: "phone.full", confidence: 0.95 }]
                : []),
          ],
        };
      } else if (operation === "tier3Ticket") {
        response = { ticket: "fake.ticket", expiresAt: new Date(Date.now() + 60_000).toISOString() };
      } else if (operation === "readWithConsent") {
        const request = body as CloudRequests["readWithConsent"];
        response = {
          values: request.items
            .filter((item) => item.label === "電話番号" && request.requestedKeys.includes("phone.full"))
            .map((item) => ({ itemId: item.id, attributeKey: "phone.full", value: item.text })),
        };
      } else if (operation === "feedback") response = { accepted: true };
      else response = {};
      return response;
    };
    server = createServer(
      { key: await readFile(keyPath), cert: await readFile(certPath) },
      (request, response) => {
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        if (request.method === "OPTIONS") {
          response.writeHead(204).end();
          return;
        }
        const operation = paths[new URL(request.url ?? "/", apiOrigin).pathname];
        if (!operation || request.method !== "POST") {
          response.writeHead(404).end();
          return;
        }
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CloudRequests[CloudOperation];
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(respond(operation, body)));
          } catch {
            response.writeHead(400).end();
          }
        });
      },
    );
    await new Promise<void>((resolve, reject) =>
      server!.listen(43365, "127.0.0.1", () => resolve()).once("error", reject),
    );
    await context.route(`${apiOrigin}/**`, async (route) => {
      const operation = paths[new URL(route.request().url()).pathname];
      if (!operation || route.request().method() !== "POST") return route.abort();
      const body = route.request().postDataJSON() as CloudRequests[CloudOperation];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(respond(operation, body)),
      });
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    worker.on("close", () => diagnostics.push("worker-closed"));
    worker.on("console", (message) => {
      if (message.type() === "error") diagnostics.push(message.text().slice(0, 200));
    });
    const extensionId = new URL(worker.url()).host;
    const seed = await context.newPage();
    await seed.goto(`chrome-extension://${extensionId}/seed-vault.html?page=${page}`);
    await seed.evaluate(() => window.demoSeed);
    await seed.close();
    const fixture = await context.newPage();
    await fixture.goto(`${siteOrigin}/${page}`);
    const panel = await context.newPage();
    panel.on("console", (message) => {
      if (message.type() === "error") diagnostics.push(message.text().slice(0, 200));
    });
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panel.getByLabel("マスターパスフレーズ").fill("fake-demo-passphrase-565");
    await panel.getByRole("button", { name: "解錠", exact: true }).click();
    await panel.getByText(`Demo ${page}`).waitFor();
    return {
      context,
      fixture,
      panel,
      requests,
      diagnostics,
      async run() {
        await fixture.bringToFront();
        await panel.evaluate(async (targetUrl) => {
          const permission = await chrome.permissions.contains({
            origins: ["https://demo.example/*", "https://*.demo.example/*"],
          });
          if (!permission) throw new Error("fixture permission missing");
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (active?.url !== targetUrl) throw new Error(`wrong active tab: ${active?.url ?? "none"}`);
          const button = document.querySelector<HTMLButtonElement>("li button");
          if (!button) throw new Error("collect button missing");
          button.click();
        }, fixture.url());
      },
      async probeFingerprint() {
        return panel.evaluate(async (url) => {
          const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url);
          if (!tab?.id) return "missing-tab";
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-script.js"] });
          const bound = await chrome.tabs.sendMessage<Record<string, unknown>>(tab.id, {
            version: 1,
            kind: "lease.bind",
            leaseId: "probe",
            epoch: 1,
            origin: "https://demo.example",
            siteDomain: "demo.example",
          });
          if (!bound?.ok) return "bind-failed";
          const result = await chrome.tabs.sendMessage<Record<string, unknown>>(tab.id, {
            version: 1,
            kind: "page.command",
            requestId: "probe",
            leaseId: "probe",
            epoch: 1,
            command: { command: "schemaFingerprint" },
          });
          return result?.ok ? String(result.payload) : String(result?.error ?? result?.reason ?? "failed");
        }, fixture.url());
      },
      async inspect() {
        await panel.close();
        const inspector = await context!.newPage();
        try {
          await inspector.goto(`chrome-extension://${extensionId}/seed-vault.html?mode=inspect`);
          return await inspector.evaluate(() => window.demoSeed!);
        } finally {
          await inspector.close();
        }
      },
      async close() {
        await context?.close();
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await context?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export function payloadHash(payload: object): string {
  // Matches the stable tier3PayloadJson order: payload was built in that order.
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
