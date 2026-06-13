// Local-only test-site server for the PoC. Serves the 10 fictional sites plus
// inspection endpoints used by the measurement runner. No external network use.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SITES, editSpecs, type SiteDef } from "./defs.js";
import { esc, formPage, nav, page, renderFields } from "./html.js";

export interface SiteEvent {
  type: "register" | "update";
  at: number;
  data: Record<string, string>;
}

export interface SiteState {
  registered?: Record<string, string>;
  events: SiteEvent[];
}

export interface PocServer {
  url: string;
  siteUrl(siteId: string): string;
  state(siteId: string): SiteState;
  reset(): void;
  close(): Promise<void>;
}

export async function startPocServer(port = 0): Promise<PocServer> {
  const states = new Map<string, SiteState>();
  const stateFor = (id: string): SiteState => {
    let s = states.get(id);
    if (!s) {
      s = { events: [] };
      states.set(id, s);
    }
    return s;
  };

  const server = createServer((req, res) => {
    void handle(req, res, stateFor).catch((err: unknown) => {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`server error: ${String(err)}`);
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://127.0.0.1:${actualPort}`;

  return {
    url,
    siteUrl: (siteId) => `${url}/site/${siteId}/`,
    state: (siteId) => stateFor(siteId),
    reset: () => states.clear(),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  stateFor: (id: string) => SiteState,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  const send = (html: string, status = 200): void => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  };
  const sendJson = (data: unknown, status = 200): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  };

  if (path === "/") {
    const list = SITES.map((s) => `<li><a href="/site/${s.id}/">${esc(s.serviceName)} (${s.id})</a></li>`).join("");
    send(page("PoC テストサイト一覧", `<h1>PoC テストサイト一覧</h1><ul>${list}</ul>`));
    return;
  }

  if (path.startsWith("/api/state/")) {
    sendJson(stateFor(path.slice("/api/state/".length)));
    return;
  }
  if (path === "/api/reset" && req.method === "POST") {
    for (const s of SITES) {
      const st = stateFor(s.id);
      delete st.registered;
      st.events = [];
    }
    sendJson({ ok: true });
    return;
  }

  if (path.startsWith("/wall-fixture/")) {
    send(wallFixture(path.slice("/wall-fixture/".length)));
    return;
  }

  if (path.startsWith("/wall-flow/") || path === "/wall-flow") {
    const form = req.method === "POST" ? await readForm(req) : {};
    send(wallFlowFixture(path, req.method ?? "GET", form));
    return;
  }

  const m = /^\/site\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) {
    send(page("Not Found", "<h1>404 Not Found</h1>"), 404);
    return;
  }
  const site = SITES.find((s) => s.id === m[1]);
  if (!site) {
    send(page("Not Found", "<h1>404 Not Found</h1>"), 404);
    return;
  }
  const sub = m[2] && m[2] !== "" ? m[2] : "/";
  const base = `/site/${site.id}`;
  const state = stateFor(site.id);
  const form = req.method === "POST" ? await readForm(req) : {};

  const html = routeSite(site, base, sub, req.method ?? "GET", form, state, sendJson);
  if (html !== undefined) send(html);
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      return JSON.parse(body) as Record<string, string>;
    } catch {
      return {};
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

function navLinks(site: SiteDef): { href: string; label: string }[] {
  const links = [{ href: "/", label: "ホーム" }, ...site.decoyLinks];
  // The registration link is deliberately mixed into ordinary navigation so the
  // agent has to pick it out by wording (RFC-001 v3 §4 step 1).
  links.splice(1 + Math.min(1, site.decoyLinks.length), 0, { href: site.registerPath, label: site.registerLinkLabel });
  // Registered-info page, used by the bulk-update scenario (§5).
  links.push({ href: "/edit", label: "登録情報の変更" });
  return links;
}

function termsSection(site: SiteDef): string {
  if (!site.termsText || !site.termsInline) return "";
  return `<h2>利用規約</h2><section class="terms">${site.termsText
    .split("\n")
    .map((l) => `<p>${esc(l)}</p>`)
    .join("")}</section>
<p class="notice"><a href="terms">利用規約の全文はこちら</a></p>`;
}

function successPage(site: SiteDef, base: string, message: string): string {
  return page(
    `${site.serviceName} - 完了`,
    `${nav(base, navLinks(site))}<h1>${esc(message)}</h1><p>ご利用ありがとうございます。</p>`,
  );
}

function recordSubmission(state: SiteState, type: "register" | "update", data: Record<string, string>): void {
  state.registered = { ...(type === "update" ? state.registered : {}), ...data };
  state.events.push({ type, at: Date.now(), data });
}

function routeSite(
  site: SiteDef,
  base: string,
  sub: string,
  method: string,
  form: Record<string, string>,
  state: SiteState,
  sendJson: (data: unknown, status?: number) => void,
): string | undefined {
  const links = navLinks(site);

  // Top page
  if (sub === "/" && method === "GET") {
    return page(
      site.serviceName,
      `${nav(base, links)}
<h1>${esc(site.serviceName)}</h1>
<p>${esc(site.serviceName)}へようこそ。本サイトは自動入力エージェント検証用のダミーサイトです。</p>
${site.intro ? `<p>${esc(site.intro)}</p>` : ""}
<p><a href="${esc(base + site.registerPath)}">${esc(site.registerLinkLabel)}</a></p>`,
    );
  }

  // Terms page
  if (sub === "/terms" && site.termsText) {
    return page(
      `${site.serviceName} - 利用規約`,
      `${nav(base, links)}<h1>利用規約</h1>${site.termsText.split("\n").map((l) => `<p>${esc(l)}</p>`).join("")}`,
    );
  }

  // Decoy pages
  if (site.decoyLinks.some((d) => d.href === sub) && method === "GET") {
    return page(
      site.serviceName,
      `${nav(base, links)}<h1>${esc(site.decoyLinks.find((d) => d.href === sub)?.label ?? "")}</h1><p>ダミーページです。</p>`,
    );
  }

  // Wizard site (06)
  if (site.steps) return routeWizard(site, base, sub, method, form, state, links);

  // Dynamic SPA-like site (07)
  if (site.dynamic) {
    if (sub === site.registerPath && method === "GET") return dynamicShell(site, base, links);
    if (sub === "/api/register" && method === "POST") {
      recordSubmission(state, "register", form);
      sendJson({ ok: true });
      return undefined;
    }
  }

  // Plain single-step registration
  if (sub === site.registerPath) {
    if (method === "GET") {
      return formPage({
        title: `${site.serviceName} - ${site.registerLinkLabel}`,
        base,
        navLinks: links,
        heading: site.registerLinkLabel,
        action: base + site.registerPath,
        layout: site.layout,
        specs: site.specs,
        submitLabel: site.submitLabel,
        beforeForm: `${site.intro ? `<p>${esc(site.intro)}</p>` : ""}${termsSection(site)}`,
      });
    }
    recordSubmission(state, "register", form);
    return successPage(site, base, "登録が完了しました");
  }

  // Edit (registered info) page
  if (sub === "/edit") {
    if (!state.registered) return page(site.serviceName, `${nav(base, links)}<h1>登録がありません</h1>`);
    if (method === "GET") {
      return formPage({
        title: `${site.serviceName} - 登録情報の変更`,
        base,
        navLinks: links,
        heading: "登録情報の変更",
        action: `${base}/edit`,
        layout: site.layout,
        specs: editSpecs(site),
        submitLabel: "変更を保存",
        values: state.registered,
      });
    }
    recordSubmission(state, "update", form);
    return successPage(site, base, "変更を保存しました");
  }

  return page("Not Found", "<h1>404 Not Found</h1>");
}

function routeWizard(
  site: SiteDef,
  base: string,
  sub: string,
  method: string,
  form: Record<string, string>,
  state: SiteState,
  links: { href: string; label: string }[],
): string | undefined {
  const steps = site.steps ?? [];
  const hidden = (data: Record<string, string>): string =>
    Object.entries(data)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join("\n");
  const stepPage = (idx: number, carried: Record<string, string>): string => {
    const isLast = idx === steps.length - 1;
    return page(
      `${site.serviceName} - 会員登録 STEP${idx + 1}`,
      `${nav(base, links)}
<h1>会員登録 STEP${idx + 1}/${steps.length}</h1>
<form method="post" action="${esc(`${base}/register/${isLast ? "confirm" : `step${idx + 2}`}`)}">
${hidden(carried)}
${renderFields(steps[idx] ?? [], site.layout)}
<div class="row"><button type="submit">${isLast ? "確認画面へ" : "次へ"}</button></div>
</form>`,
    );
  };

  if (sub === "/register/step1" && method === "GET") return stepPage(0, {});
  for (let i = 1; i < steps.length; i++) {
    if (sub === `/register/step${i + 1}` && method === "POST") return stepPage(i, form);
  }
  if (sub === "/register/confirm" && method === "POST") {
    const rows = site.specs
      .filter((f) => f.type !== "password")
      .map((f) => `<tr><th>${esc(f.label)}</th><td>${esc(form[f.name] ?? "")}</td></tr>`)
      .join("\n");
    return page(
      `${site.serviceName} - 入力内容の確認`,
      `${nav(base, links)}
<h1>入力内容の確認</h1>
<table class="form">${rows}</table>
<form method="post" action="${esc(`${base}/register/complete`)}">
${hidden(form)}
<div class="row"><button type="submit">登録する</button></div>
</form>`,
    );
  }
  if (sub === "/register/complete" && method === "POST") {
    recordSubmission(state, "register", form);
    return successPage(site, base, "登録が完了しました");
  }

  // Edit page falls through to the generic handler
  if (sub === "/edit") {
    if (!state.registered) return page(site.serviceName, `${nav(base, links)}<h1>登録がありません</h1>`);
    if (method === "GET") {
      return formPage({
        title: `${site.serviceName} - 登録情報の変更`,
        base,
        navLinks: links,
        heading: "登録情報の変更",
        action: `${base}/edit`,
        layout: site.layout,
        specs: editSpecs(site),
        submitLabel: "変更を保存",
        values: state.registered,
      });
    }
    recordSubmission(state, "update", form);
    return successPage(site, base, "変更を保存しました");
  }
  return page("Not Found", "<h1>404 Not Found</h1>");
}

function dynamicShell(site: SiteDef, base: string, links: { href: string; label: string }[]): string {
  const fieldsJson = JSON.stringify(
    site.specs.map((f) => ({
      name: f.name,
      id: f.id ?? f.name,
      label: f.label,
      type: f.type ?? "text",
      required: f.required ?? false,
    })),
  );
  return page(
    `${site.serviceName} - サインアップ`,
    `${nav(base, links)}
<h1>サインアップ</h1>
<div id="app"><p>読み込み中…</p></div>
<script>
const FIELDS = ${fieldsJson};
setTimeout(() => {
  const app = document.getElementById("app");
  const form = document.createElement("form");
  for (const f of FIELDS) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("label");
    label.htmlFor = f.id;
    label.textContent = f.label + (f.required ? "（必須）" : "");
    const input = document.createElement("input");
    input.type = f.type; input.name = f.name; input.id = f.id; input.required = f.required;
    row.append(label, input);
    form.append(row);
  }
  const btn = document.createElement("button");
  btn.type = "submit";
  btn.textContent = ${JSON.stringify(site.submitLabel)};
  form.append(btn);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const res = await fetch("${base}/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) app.innerHTML = "<p>登録が完了しました。</p>";
  });
  app.replaceChildren(form);
}, 400);
</script>`,
  );
}

/** Pages used only to verify the wall-detection skeleton (not part of the 10 patterns). */
function wallFixture(kind: string): string {
  switch (kind) {
    case "captcha":
      return page(
        "認証",
        `<h1>セキュリティ確認</h1>
<p>私はロボットではありません</p>
<div class="g-recaptcha" data-sitekey="dummy"></div>
<iframe src="/wall-fixture/recaptcha-frame" title="reCAPTCHA"></iframe>`,
      );
    case "otp":
      return page(
        "2段階認証",
        `<h1>2段階認証</h1>
<p>登録された電話番号に送信された認証コードを入力してください。</p>
<form><label for="otp">認証コード</label>
<input id="otp" name="otp" autocomplete="one-time-code" inputmode="numeric">
<button>確認</button></form>`,
      );
    case "email":
      return page(
        "メール確認",
        `<h1>確認メールを送信しました</h1>
<p>メール内の確認リンクをクリックして、登録を完了してください。</p>`,
      );
    default:
      return page("Not Found", "<h1>404</h1>");
  }
}

/** Registration flow fixture where a wall appears after final submit. */
function wallFlowFixture(path: string, method: string, form: Record<string, string>): string {
  const base = "/wall-flow";
  if ((path === "/wall-flow/" || path === "/wall-flow") && method === "GET") {
    return page(
      "壁つき登録テスト",
      `<h1>壁つき登録テスト</h1>
<p><a href="${base}/register">新規登録</a></p>`,
    );
  }
  if (path === "/wall-flow/register" && method === "GET") {
    return page(
      "壁つき登録テスト - 新規登録",
      `<h1>新規登録</h1>
<form method="post" action="${base}/submit">
  <div class="row"><label for="name">氏名</label><input id="name" name="name" autocomplete="name" required></div>
  <div class="row"><label for="email">メールアドレス</label><input id="email" name="email" type="email" autocomplete="email" required></div>
  <div class="row"><label for="password">パスワード</label><input id="password" name="password" type="password" autocomplete="new-password" required></div>
  <div class="row"><button type="submit">登録する</button></div>
</form>`,
    );
  }
  if (path === "/wall-flow/submit" && method === "POST") {
    const hidden = Object.entries(form)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join("\n");
    return page(
      "セキュリティ確認",
      `<h1>セキュリティ確認</h1>
<p>私はロボットではありません</p>
<div class="g-recaptcha" data-sitekey="dummy"></div>
<form method="post" action="${base}/success">
${hidden}
<button type="submit">人間が確認を完了</button>
</form>`,
    );
  }
  if (path === "/wall-flow/success") {
    return page("壁つき登録テスト - 完了", "<h1>登録が完了しました</h1>");
  }
  return page("Not Found", "<h1>404</h1>");
}
