// Local-only test-site server for the PoC. Serves the 10 fictional sites plus
// inspection endpoints used by the measurement runner. No external network use.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SITES, editSpecs, type SiteDef } from "./defs.js";
import { esc, formPage, nav, page, renderFields } from "./html.js";

export interface SiteEvent {
  type: "register" | "update" | "withdraw";
  at: number;
  data: Record<string, string>;
}

export interface SiteState {
  registered?: Record<string, string>;
  events: SiteEvent[];
}

/**
 * State for the /explore-flow/* fixture (Issue #251) — see exploreFlowFixture
 * below. Not one of the 10 SITES, so it does not use the per-siteId
 * SiteState map.
 */
interface ExploreFlowState {
  paymentWallCleared: boolean;
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
  // Issue #251: single mutable slot for the /explore-flow/* fixture, independent
  // of the per-siteId `states` map above.
  const exploreFlowState: ExploreFlowState = { paymentWallCleared: false };

  const server = createServer((req, res) => {
    void handle(req, res, stateFor, exploreFlowState).catch((err: unknown) => {
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
  exploreFlowState: ExploreFlowState,
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

  if (path.startsWith("/explore-flow/") || path === "/explore-flow") {
    const form = req.method === "POST" ? await readForm(req) : {};
    send(exploreFlowFixture(path, req.method ?? "GET", form, exploreFlowState));
    return;
  }

  if (path.startsWith("/login-wall/") || path === "/login-wall") {
    const form = req.method === "POST" ? await readForm(req) : {};
    send(loginWallFixture(path, req.method ?? "GET", form));
    return;
  }

  if (path.startsWith("/saved-page-guide/") || path === "/saved-page-guide") {
    send(savedPageGuideFixture(path));
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

/**
 * Login page for a site. Shows a simple email+password form.
 * POST: if the site has a registered account, redirects to /account (settings page).
 * Otherwise returns a "not found" error (simulates wrong credentials).
 */
function loginPage(site: SiteDef, base: string, state: SiteState, method: string, form: Record<string, string>): string {
  const links = navLinks(site);
  if (method === "POST") {
    if (state.registered && form["email"] === state.registered["email"]) {
      // Simulate successful login → redirect to account page via meta-refresh
      return page(
        `${site.serviceName} - ログイン成功`,
        `${nav(base, links)}<h1>ログインしました</h1>
<p>アカウント情報ページへ移動します。</p>
<meta http-equiv="refresh" content="0;url=${base}/account">`,
      );
    }
    return page(
      `${site.serviceName} - ログイン`,
      `${nav(base, links)}
<h1>ログイン</h1>
<p style="color:red">メールアドレスまたはパスワードが正しくありません。</p>
<form method="post" action="${base}/login">
<div class="row"><label for="login_email">メールアドレス</label><input id="login_email" name="email" type="email" autocomplete="email" required value="${esc(form["email"] ?? "")}"></div>
<div class="row"><label for="login_password">パスワード</label><input id="login_password" name="password" type="password" autocomplete="current-password" required></div>
<div class="row"><button type="submit">ログイン</button></div>
</form>`,
    );
  }
  return page(
    `${site.serviceName} - ログイン`,
    `${nav(base, links)}
<h1>ログイン</h1>
<form method="post" action="${base}/login">
<div class="row"><label for="login_email">メールアドレス</label><input id="login_email" name="email" type="email" autocomplete="email" required></div>
<div class="row"><label for="login_password">パスワード</label><input id="login_password" name="password" type="password" autocomplete="current-password" required></div>
<div class="row"><button type="submit">ログイン</button></div>
</form>`,
  );
}

/**
 * Account settings page (read-only profile view) for a site.
 * Displays registered values in readonly input fields so the import scanner
 * can extract them without the user entering data. This simulates a typical
 * account-profile page where values are pre-populated but not editable inline.
 */
function accountPage(site: SiteDef, base: string, state: SiteState): string {
  const links = navLinks(site);
  if (!state.registered) {
    return page(
      `${site.serviceName} - アカウント`,
      `${nav(base, links)}<h1>アカウント情報</h1><p>ログインが必要です。<a href="${base}/login">ログインする</a></p>`,
    );
  }
  const specs = editSpecs(site);
  const rows = specs
    .map((f) => {
      const val = state.registered![f.name] ?? "";
      return `<div class="row"><label for="acc_${esc(f.name)}">${esc(f.label)}</label><input id="acc_${esc(f.name)}" name="${esc(f.name)}" value="${esc(val)}" readonly></div>`;
    })
    .join("\n");
  return page(
    `${site.serviceName} - アカウント情報`,
    `${nav(base, links)}
<h1>アカウント情報</h1>
<form>
${rows}
</form>
<p><a href="${base}/edit">登録情報を変更する</a></p>
<p><a href="${base}/withdraw">退会手続き</a></p>`,
  );
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

  // Login and account pages take priority over decoy-link fallback.
  if (sub === "/login") return loginPage(site, base, state, method, form);
  if (sub === "/account") return accountPage(site, base, state);
  if (sub === "/withdraw") {
    if (!state.registered) return page(site.serviceName, `${nav(base, links)}<h1>登録がありません</h1>`);
    if (method === "POST") {
      state.events.push({ type: "withdraw", at: Date.now(), data: form });
      delete state.registered;
      return successPage(site, base, "退会が完了しました");
    }
    return page(
      `${site.serviceName} - 退会手続き`,
      `${nav(base, links)}
<h1>退会手続き</h1>
<p>退会するとアカウントは削除されます。この最終操作はユーザーが確認して実行してください。</p>
<form method="post" action="${base}/withdraw">
<div class="row"><button type="submit">退会する</button></div>
</form>`,
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
        afterForm: `<p><a href="${base}/withdraw">退会手続き</a></p>`,
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

/**
 * Login-then-MFA fixture: simulates a site where logging in triggers a
 * one-time-code wall. Used to test wall hand-off/resume from the import flow.
 */
function loginWallFixture(path: string, method: string, form: Record<string, string>): string {
  const base = "/login-wall";
  if ((path === "/login-wall" || path === "/login-wall/") && method === "GET") {
    return page(
      "ログイン壁テスト",
      `<h1>ログイン壁テスト</h1>
<p><a href="${base}/login">ログイン</a></p>`,
    );
  }
  if (path === "/login-wall/login" && method === "GET") {
    return page(
      "ログイン壁テスト - ログイン",
      `<h1>ログイン</h1>
<form method="post" action="${base}/login">
  <div class="row"><label for="lw_email">メールアドレス</label><input id="lw_email" name="email" type="email" autocomplete="email" required></div>
  <div class="row"><label for="lw_password">パスワード</label><input id="lw_password" name="password" type="password" autocomplete="current-password" required></div>
  <div class="row"><button type="submit">ログイン</button></div>
</form>`,
    );
  }
  if (path === "/login-wall/login" && method === "POST") {
    return page(
      "2段階認証",
      `<h1>2段階認証</h1>
<p>ご登録の電話番号に送信された認証コードを入力してください。</p>
<form method="post" action="${base}/verify">
  <input type="hidden" name="email" value="${esc(form["email"] ?? "")}">
  <div class="row"><label for="lw_otp">認証コード（6桁）</label><input id="lw_otp" name="otp" autocomplete="one-time-code" inputmode="numeric" maxlength="6" required></div>
  <div class="row"><button type="submit">認証する</button></div>
</form>`,
    );
  }
  if (path === "/login-wall/verify" && method === "POST") {
    return page(
      "ログイン壁テスト - アカウント",
      `<h1>アカウント情報</h1>
<dl>
  <div class="row"><dt>メールアドレス</dt><dd>${esc(form["email"] ?? "")}</dd></div>
</dl>`,
    );
  }
  return page("Not Found", "<h1>404</h1>");
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

// Issue #251: fixed fictional credentials for the /explore-flow/* fixture below.
// The account is always "already registered" (no /register endpoint), so the
// E2E test only needs these constants to build its CSV import row.
const EXPLORE_FLOW_EMAIL = "explore-user@example.test";
const EXPLORE_FLOW_PASSWORD = "Explore-Fake-Passw0rd!";
const EXPLORE_FLOW_ZIP = "100-0002";
const EXPLORE_FLOW_CARD_NUMBER = "4111 1111 1111 5678";
const EXPLORE_FLOW_CARD_CVV = "321";

/**
 * Multi-page + wall exploration fixture (Issue #251), used only by
 * tests/e2e/app-ui-exploration.e2e.ts. Not one of the 10 SITES (same tier as
 * wallFlowFixture above), so it is never iterated by run/measure.ts's
 * CI-gated registration/bulk-update matrix.
 *
 * login → mypage → {profile, address, payment}. `payment` shows a
 * CAPTCHA-style wall on its first GET and clears on the next: PageExplorer's
 * resume() always re-`goto()`s the same deferred URL
 * (src/automation/page-explorer.ts), so a fresh visit returning different
 * content is exactly how a real site remembering a solved wall for the
 * session would behave.
 */
function exploreFlowFixture(
  path: string,
  method: string,
  form: Record<string, string>,
  state: ExploreFlowState,
): string {
  const base = "/explore-flow";
  if ((path === base || path === `${base}/`) && method === "GET") {
    return page("探索テスト商店", `<h1>探索テスト商店</h1>\n<p><a href="${base}/login">ログイン</a></p>`);
  }

  if (path === `${base}/login` && method === "GET") {
    return page(
      "探索テスト商店 - ログイン",
      `<h1>ログイン</h1>
<form method="post" action="${base}/login">
<div class="row"><label for="ef_email">メールアドレス</label><input id="ef_email" name="email" type="email" autocomplete="email" required></div>
<div class="row"><label for="ef_password">パスワード</label><input id="ef_password" name="password" type="password" autocomplete="current-password" required></div>
<div class="row"><button type="submit">ログイン</button></div>
</form>`,
    );
  }
  if (path === `${base}/login` && method === "POST") {
    if (form["email"] === EXPLORE_FLOW_EMAIL && form["password"] === EXPLORE_FLOW_PASSWORD) {
      return page(
        "探索テスト商店 - ログイン成功",
        `<h1>ログインしました</h1>
<p>マイページへ移動します。</p>
<meta http-equiv="refresh" content="0;url=${base}/mypage">`,
      );
    }
    return page(
      "探索テスト商店 - ログイン",
      `<h1>ログイン</h1>
<p style="color:red">メールアドレスまたはパスワードが正しくありません。</p>
<form method="post" action="${base}/login">
<div class="row"><label for="ef_email">メールアドレス</label><input id="ef_email" name="email" type="email" autocomplete="email" required value="${esc(form["email"] ?? "")}"></div>
<div class="row"><label for="ef_password">パスワード</label><input id="ef_password" name="password" type="password" autocomplete="current-password" required></div>
<div class="row"><button type="submit">ログイン</button></div>
</form>`,
    );
  }

  if (path === `${base}/mypage` && method === "GET") {
    return page(
      "探索テスト商店 - マイページ",
      `<h1>マイページ</h1>
<ul>
<li><a href="${base}/profile">会員情報</a></li>
<li><a href="${base}/address">お届け先住所</a></li>
<li><a href="${base}/payment">お支払い方法</a></li>
</ul>`,
    );
  }

  if (path === `${base}/profile` && method === "GET") {
    return page(
      "探索テスト商店 - 会員情報",
      `<h1>会員情報</h1>
<form>
<div class="row"><label for="ef_profile_email">メールアドレス</label><input id="ef_profile_email" name="email" autocomplete="email" value="${esc(EXPLORE_FLOW_EMAIL)}" readonly></div>
</form>`,
    );
  }

  if (path === `${base}/address` && method === "GET") {
    return page(
      "探索テスト商店 - お届け先住所",
      `<h1>お届け先住所</h1>
<form>
<div class="row"><label for="ef_zip">郵便番号</label><input id="ef_zip" name="zip" autocomplete="postal-code" value="${esc(EXPLORE_FLOW_ZIP)}" readonly></div>
</form>`,
    );
  }

  if (path === `${base}/payment` && method === "GET") {
    if (!state.paymentWallCleared) {
      state.paymentWallCleared = true;
      return page(
        "認証",
        `<h1>セキュリティ確認</h1>
<p>私はロボットではありません</p>
<div class="g-recaptcha" data-sitekey="dummy"></div>
<iframe src="/wall-fixture/recaptcha-frame" title="reCAPTCHA"></iframe>`,
      );
    }
    return page(
      "探索テスト商店 - お支払い方法",
      `<h1>お支払い方法</h1>
<form>
<div class="row"><label for="ef_card">カード番号</label><input id="ef_card" name="card_number" autocomplete="cc-number" value="${esc(EXPLORE_FLOW_CARD_NUMBER)}" readonly></div>
<div class="row"><label for="ef_cvv">セキュリティコード</label><input id="ef_cvv" name="card_cvv" autocomplete="cc-csc" value="${esc(EXPLORE_FLOW_CARD_CVV)}" readonly></div>
</form>`,
    );
  }

  return page("Not Found", "<h1>404</h1>");
}

/** Dummy pages for the saved-page import guide. Fake values only; no real-site screenshots needed. */
function savedPageGuideFixture(path: string): string {
  const base = "/saved-page-guide";
  if (path === "/saved-page-guide" || path === "/saved-page-guide/") {
    return page(
      "保存ページ取り込みガイド",
      `<h1>保存ページ取り込みガイド</h1>
<p>このページ群は Soroeru の案内用スクリーンショット/GIF を撮るためのローカルダミーサイトです。</p>
<ul>
  <li><a href="${base}/wall">セキュリティ確認の例</a></li>
  <li><a href="${base}/account">登録情報ページの例</a></li>
</ul>`,
    );
  }
  if (path === "/saved-page-guide/wall") {
    return page(
      "セキュリティ確認の例",
      `<h1>セキュリティ確認</h1>
<p>この表示はダミーです。実際の CAPTCHA ウィジェットではありません。</p>
<div style="border:1px solid #aaa; padding:1rem; width:20rem; background:#f8f8f8">
  <label><input type="checkbox"> 私はロボットではありません</label>
  <p class="notice">安全確認の例</p>
</div>
<p><a href="${base}/account">確認後の登録情報ページへ進む</a></p>`,
    );
  }
  if (path === "/saved-page-guide/account") {
    return page(
      "登録情報ページの例",
      `<h1>登録情報</h1>
<p>下の値はすべて架空のテストデータです。</p>
<form>
  <div class="row"><label for="guide_name">氏名</label><input id="guide_name" name="name" autocomplete="name" value="山田 テスト"></div>
  <div class="row"><label for="guide_email">メールアドレス</label><input id="guide_email" name="email" type="email" autocomplete="email" value="guide-user@example.test"></div>
  <div class="row"><label for="guide_zip">郵便番号</label><input id="guide_zip" name="address[zip]" value="100-0001"></div>
  <div class="row"><label for="guide_city">市区町村</label><input id="guide_city" name="address[city]" value="千代田区"></div>
  <div class="row"><label for="guide_address">住所</label><input id="guide_address" name="address[address1]" value="千代田1-1-1"></div>
  <div class="row"><label for="guide_phone">電話番号</label><input id="guide_phone" name="address[phone]" type="tel" value="03-0000-0000"></div>
</form>
<p class="notice">Chrome で右クリック → 別名で保存 → ウェブページ、HTML のみ、の撮影に使います。</p>`,
    );
  }
  return page("Not Found", "<h1>404</h1>");
}
