// Local browser UI shell for Issue #66.
//
// This is intentionally server-rendered over Node's built-in HTTP server for
// the first implementation slice: no new frontend framework, no telemetry, and
// no remote backend. The server binds to 127.0.0.1 by default and all writes go
// through AutofillApp/PocStore so encrypted-at-rest behavior stays unchanged.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { maskValue } from "../agent/gate.js";
import { staleFilledFields } from "../agent/records.js";
import {
  isSensitiveKey,
  KNOWN_PROFILE_KEYS,
  PROFILE_FIELD_LABELS,
  type KnownProfileKey,
  type ProfileKey,
  type SiteRecord,
} from "../types.js";
import type { ProfileEntry, ProviderSettings } from "../store/store.js";
import { AutofillApp, AutofillAppError } from "./app.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4127;
const FORM_LIMIT_BYTES = 128 * 1024;
const URL_BASE = "http" + "://127.0.0.1";

type FlashKind = "ok" | "error" | "warn";
type AppTab = "profile" | "sites" | "settings";
type ProfileMode = "view" | "edit";

interface Flash {
  kind: FlashKind;
  message: string;
}

interface Reveal {
  label: string;
  value: string;
  warning?: string;
}

interface PageState {
  tab: AppTab;
  profileMode: ProfileMode;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface WebUiServerOptions {
  app: AutofillApp;
  host?: string;
  port?: number;
  log?: (message: string) => void;
}

export interface WebUiServerHandle {
  url: string;
  close: () => Promise<void>;
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asKnownProfileKey(value: string): KnownProfileKey | undefined {
  return (KNOWN_PROFILE_KEYS as readonly string[]).includes(value) ? (value as KnownProfileKey) : undefined;
}

function asProfileKey(value: string): ProfileKey | undefined {
  const known = asKnownProfileKey(value);
  if (known) return known;
  return /^custom\.[a-zA-Z0-9_-]+$/.test(value) ? (value as ProfileKey) : undefined;
}

function profileLabel(key: ProfileKey): string {
  const known = asKnownProfileKey(key);
  return known ? PROFILE_FIELD_LABELS[known] : key;
}

function splitTerms(value: string): string[] | undefined {
  const terms = value
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);
  return terms.length > 0 ? terms : undefined;
}

function formValue(form: URLSearchParams, name: string): string {
  return (form.get(name) ?? "").trim();
}

function activeTab(params: URLSearchParams): AppTab {
  const tab = params.get("tab");
  return tab === "sites" || tab === "settings" ? tab : "profile";
}

function profileMode(params: URLSearchParams): ProfileMode {
  return params.get("mode") === "edit" ? "edit" : "view";
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > FORM_LIMIT_BYTES) throw new HttpError(413, "送信内容が大きすぎます");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function statusText(status: number): string {
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  if (status === 413) return "Payload Too Large";
  return "Error";
}

class WebUiServer {
  private readonly app: AutofillApp;
  private readonly host: string;
  private readonly port: number;
  private readonly log: (message: string) => void;
  private readonly csrfToken = randomBytes(24).toString("base64url");
  private readonly server: Server;

  constructor(options: WebUiServerOptions) {
    this.app = options.app;
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.log = options.log ?? (() => {});
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => this.handleError(err, res));
    });
  }

  async start(): Promise<WebUiServerHandle> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address() as AddressInfo;
    const scheme = "http";
    const url = `${scheme}://${this.host}:${address.port}/`;
    return {
      url,
      close: async () => {
        await new Promise<void>((resolve, reject) => {
          this.server.close((err) => (err ? reject(err) : resolve()));
        });
      },
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", URL_BASE);
    if (method === "GET" && url.pathname === "/") {
      this.sendHtml(res, 200, this.renderHome(this.flashFromQuery(url.searchParams), undefined, this.pageState(url.searchParams)));
      return;
    }
    if (method !== "POST") throw new HttpError(404, "ページが見つかりません");

    const form = await readForm(req);
    this.assertCsrf(form);
    switch (url.pathname) {
      case "/unlock":
        await this.unlock(form, res);
        return;
      case "/unlock-recovery":
        await this.unlockWithRecovery(form, res);
        return;
      case "/lock":
        this.app.lock();
        this.redirect(res, "ok", "ロックしました。復帰するにはパスフレーズを入力してください。");
        return;
      case "/profile/save":
        await this.saveProfile(form, res);
        return;
      case "/profile/save-all":
        await this.saveAllProfile(form, res);
        return;
      case "/profile/delete":
        await this.deleteProfile(form, res);
        return;
      case "/profile/reveal":
        await this.revealProfile(form, res);
        return;
      case "/settings/provider":
        await this.saveProviderSettings(form, res);
        return;
      case "/settings/reveal-api-key":
        await this.revealApiKey(form, res);
        return;
      case "/recovery/generate":
        await this.generateRecoveryKey(res);
        return;
      case "/recovery/verify":
        await this.verifyRecoveryKey(form, res);
        return;
      case "/recovery/remove":
        await this.removeRecoveryKey(res);
        return;
      case "/registration/start":
        this.redirect(res, "warn", "新規登録のWeb実行は次の実装スライスで有効化します。", "sites");
        return;
      case "/bulk/start":
        this.redirect(res, "warn", "一括更新のWeb実行は次の実装スライスで有効化します。", "sites");
        return;
      default:
        throw new HttpError(404, "ページが見つかりません");
    }
  }

  private handleError(err: unknown, res: ServerResponse): void {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : "予期しないエラーが発生しました";
    if (status >= 500) this.log(`web ui error: ${message}`);
    this.sendHtml(
      res,
      status,
      this.renderLayout(statusText(status), `<section class="panel error"><h1>${escapeHtml(statusText(status))}</h1><p>${escapeHtml(message)}</p><a class="button secondary" href="/">戻る</a></section>`),
    );
  }

  private sendHtml(res: ServerResponse, status: number, body: string): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");
    res.end(body);
  }

  private redirect(res: ServerResponse, kind: FlashKind, message: string, tab: AppTab = "profile", mode?: ProfileMode): void {
    res.statusCode = 303;
    const params = new URLSearchParams({ tab, [kind]: message });
    if (mode) params.set("mode", mode);
    res.setHeader("Location", `/?${params.toString()}`);
    res.end();
  }

  private assertCsrf(form: URLSearchParams): void {
    if (form.get("csrf") !== this.csrfToken) throw new HttpError(403, "画面を再読み込みしてからもう一度操作してください");
  }

  private flashFromQuery(params: URLSearchParams): Flash | undefined {
    for (const kind of ["ok", "warn", "error"] as const) {
      const message = params.get(kind);
      if (message) return { kind, message };
    }
    return undefined;
  }

  private pageState(params: URLSearchParams): PageState {
    const tab = activeTab(params);
    return { tab, profileMode: tab === "profile" ? profileMode(params) : "view" };
  }

  private csrfInput(): string {
    return `<input type="hidden" name="csrf" value="${escapeHtml(this.csrfToken)}">`;
  }

  private renderHome(flash?: Flash, reveal?: Reveal, state: PageState = { tab: "profile", profileMode: "view" }): string {
    if (!this.app.isUnlocked) return this.renderLocked(flash);
    return this.renderUnlocked(flash, reveal, state);
  }

  private renderLocked(flash?: Flash): string {
    return this.renderLayout(
      "autofill",
      `
        <section class="hero-band">
          <div>
            <p class="eyebrow">Local-first autofill</p>
            <h1>autofill を開く</h1>
            <p>この画面はあなたのPC上だけで動きます。個人情報は暗号化して保存し、クラウド同期やテレメトリは使いません。</p>
          </div>
        </section>
        ${this.renderFlash(flash)}
        <section class="grid two">
          <form class="panel" method="post" action="/unlock">
            ${this.csrfInput()}
            <h2>マスターパスフレーズ</h2>
            <p class="muted">初回はここで入力した言葉が今後の鍵になります。忘れると復旧キーなしでは開けません。</p>
            <label>パスフレーズ
              <input name="passphrase" type="password" autocomplete="current-password" required>
            </label>
            <button type="submit">開く / はじめる</button>
          </form>
          <form class="panel" method="post" action="/unlock-recovery">
            ${this.csrfInput()}
            <h2>リカバリーキーで開く</h2>
            <p class="muted">事前に作ったリカバリーキーがある場合だけ使えます。キーはこのPCから外部送信されません。</p>
            <label>リカバリーキー
              <input name="recoveryKey" type="password" autocomplete="off">
            </label>
            <button type="submit" class="secondary">リカバリーキーで開く</button>
          </form>
        </section>
      `,
    );
  }

  private renderUnlocked(flash: Flash | undefined, reveal: Reveal | undefined, state: PageState): string {
    const store = this.app.store;
    const profile = [...store.profile.values()].sort((a, b) => a.key.localeCompare(b.key));
    const sites = store.listSiteRecords().sort((a, b) => b.registeredAt - a.registeredAt);
    const updateCandidates = sites
      .map((record) => ({ record, stale: staleFilledFields(store, record) }))
      .filter((candidate) => candidate.stale.length > 0);
    const settings = store.getSettings();
    return this.renderLayout(
      "autofill dashboard",
      `
        <header class="app-header">
          <div>
            <p class="eyebrow">Local web app</p>
            <h1>autofill</h1>
          </div>
          <form method="post" action="/lock">
            ${this.csrfInput()}
            <button type="submit" class="secondary">ロック</button>
          </form>
        </header>
        ${this.renderFlash(flash)}
        ${this.renderReveal(reveal)}
        <section class="summary-grid" aria-label="概要">
          ${this.metric("個人情報", `${profile.length}`, "保存済みフィールド")}
          ${this.metric("登録済みサイト", `${sites.length}`, "保存済みサイト")}
          ${this.metric("更新候補", `${updateCandidates.length}`, "差分のあるサイト")}
          ${this.metric("AI設定", settings ? settings.provider : "未設定", settings?.model ?? "APIキーは暗号化保存")}
        </section>
        <nav class="tabs" aria-label="主要画面">
          ${this.tabLink("profile", "個人情報", state.tab)}
          ${this.tabLink("sites", "登録済みサイト", state.tab)}
          ${this.tabLink("settings", "設定", state.tab)}
        </nav>
        ${this.renderActiveTab(state, profile, sites, updateCandidates, settings)}
      `,
    );
  }

  private tabLink(tab: AppTab, label: string, active: AppTab): string {
    return `<a href="/?tab=${tab}" class="${tab === active ? "active" : ""}" ${tab === active ? `aria-current="page"` : ""}>${escapeHtml(label)}</a>`;
  }

  private renderActiveTab(
    state: PageState,
    profile: ProfileEntry[],
    sites: SiteRecord[],
    updateCandidates: { record: SiteRecord; stale: ReturnType<typeof staleFilledFields> }[],
    settings: ProviderSettings | undefined,
  ): string {
    if (state.tab === "sites") return this.renderSitesSection(sites, updateCandidates);
    if (state.tab === "settings") return this.renderSettingsSection(settings);
    return this.renderProfileSection(profile, state.profileMode);
  }

  private renderLayout(title: string, body: string): string {
    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8f7;
      --surface: #ffffff;
      --surface-2: #eef5f2;
      --text: #24312f;
      --muted: #66736f;
      --line: #d7dfdc;
      --accent: #0f766e;
      --accent-2: #0b5f59;
      --warn: #a35b00;
      --error: #b42318;
      --ok: #16703a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    a { color: var(--accent-2); }
    h1, h2, h3 { margin: 0; line-height: 1.2; }
    h1 { font-size: 2rem; }
    h2 { font-size: 1.25rem; }
    h3 { font-size: 1rem; }
    main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 56px; }
    .hero-band, .app-header {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 16px;
    }
    .hero-band p { max-width: 760px; }
    .app-header { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
    .eyebrow { margin: 0 0 6px; color: var(--accent-2); font-size: .82rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
    .muted { color: var(--muted); }
    .grid { display: grid; gap: 16px; }
    .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
    .metric, .panel, .item-card {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .metric { padding: 16px; }
    .metric strong { display: block; font-size: 1.4rem; }
    .metric span { color: var(--muted); font-size: .9rem; }
    .panel { padding: 18px; margin: 16px 0; }
    .panel > h2 { margin-bottom: 12px; }
    .item-list { display: grid; gap: 10px; }
    .item-card { padding: 14px; display: grid; gap: 12px; }
    .row { display: flex; justify-content: space-between; align-items: start; gap: 12px; flex-wrap: wrap; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; }
    .tabs { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
    .tabs a {
      display: inline-flex;
      padding: 8px 12px;
      background: var(--surface-2);
      border: 1px solid var(--line);
      border-radius: 999px;
      text-decoration: none;
      color: var(--text);
      font-weight: 600;
    }
    .tabs a.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }
    .section-header h2 { margin: 0; }
    .site-action-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
      margin-bottom: 16px;
    }
    .action-panel {
      background: var(--surface-2);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
    }
    .profile-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .profile-row {
      display: grid;
      grid-template-columns: minmax(120px, 220px) minmax(0, 1fr);
      gap: 10px;
      align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid var(--line);
    }
    .profile-row:last-child { border-bottom: 0; }
    .profile-label { font-weight: 700; }
    .form-footer {
      display: flex;
      justify-content: flex-end;
      padding-top: 18px;
      margin-top: 8px;
      border-top: 1px solid var(--line);
    }
    form.stack, .stack { display: grid; gap: 12px; }
    label { display: grid; gap: 5px; font-weight: 650; }
    input, select, textarea {
      width: 100%;
      border: 1px solid #b9c4c0;
      border-radius: 6px;
      padding: 10px 11px;
      font: inherit;
      background: #fff;
      color: var(--text);
    }
    textarea { min-height: 72px; resize: vertical; }
    button, .button {
      border: 0;
      border-radius: 6px;
      background: var(--accent);
      color: #fff;
      padding: 10px 14px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    button.secondary, .button.secondary { background: #e7ecea; color: var(--text); border: 1px solid var(--line); }
    button.danger { background: var(--error); }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 8px; background: var(--surface-2); color: var(--muted); font-size: .82rem; font-weight: 700; }
    .badge.warn { color: var(--warn); background: #fff4df; }
    .flash, .reveal { border-radius: 8px; padding: 12px 14px; margin: 12px 0; border: 1px solid var(--line); background: var(--surface); }
    .flash.ok { border-color: #9fd5b5; color: var(--ok); background: #eefaf2; }
    .flash.warn { border-color: #f1cd8a; color: var(--warn); background: #fff8e8; }
    .flash.error, .panel.error { border-color: #f0aaa5; color: var(--error); background: #fff1f0; }
    .reveal code {
      display: block;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: #f0f3f2;
      color: var(--text);
      padding: 12px;
      border-radius: 6px;
      margin-top: 8px;
    }
    details { border-top: 1px solid var(--line); padding-top: 10px; }
    summary { cursor: pointer; font-weight: 700; }
    .empty { padding: 14px; border: 1px dashed #b9c4c0; border-radius: 8px; color: var(--muted); }
    .cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .small { font-size: .88rem; }
    @media (max-width: 820px) {
      main { width: min(100% - 20px, 680px); padding-top: 12px; }
      .grid.two, .summary-grid, .cols { grid-template-columns: 1fr; }
      .site-action-grid, .profile-grid, .profile-row { grid-template-columns: 1fr; }
      .app-header { align-items: stretch; }
      .app-header form { width: 100%; }
      .app-header button { width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    ${body}
  </main>
</body>
</html>`;
  }

  private renderFlash(flash?: Flash): string {
    if (!flash) return "";
    return `<div class="flash ${flash.kind}" role="status">${escapeHtml(flash.message)}</div>`;
  }

  private renderReveal(reveal?: Reveal): string {
    if (!reveal) return "";
    return `<section class="reveal" role="status"><strong>${escapeHtml(reveal.label)}</strong>${reveal.warning ? `<p class="muted">${escapeHtml(reveal.warning)}</p>` : ""}<code>${escapeHtml(reveal.value)}</code></section>`;
  }

  private metric(label: string, value: string, help: string): string {
    return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><span>${escapeHtml(help)}</span></div>`;
  }

  private renderProfileSection(entries: ProfileEntry[], mode: ProfileMode): string {
    return `
      <section id="profile" class="panel">
        <div class="section-header">
          <div>
            <h2>個人情報</h2>
            <p class="muted">一般的な登録情報編集画面として、編集ボタンから全項目をまとめて変更できます。</p>
          </div>
          ${
            mode === "edit"
              ? `<a class="button secondary" href="/?tab=profile">編集をやめる</a>`
              : `<a class="button secondary" href="/?tab=profile&mode=edit">編集</a>`
          }
        </div>
        <p class="muted">カード番号・CVV・パスワードなどは一覧で常にマスクします。表示する場合はパスフレーズを再入力します。</p>
        ${mode === "edit" ? this.renderProfileEditForm(entries) : this.renderProfileView(entries)}
      </section>
    `;
  }

  private renderProfileView(entries: ProfileEntry[]): string {
    if (entries.length === 0) return `<div class="empty">個人情報はまだ登録されていません。右上の編集ボタンから登録できます。</div>`;
    return `
      <div class="profile-list">
        ${entries.map((entry) => this.renderProfileRow(entry)).join("")}
      </div>
    `;
  }

  private renderProfileRow(entry: ProfileEntry): string {
    const sensitive = isSensitiveKey(entry.key);
    return `
      <div class="profile-row">
        <div>
          <div class="profile-label">${escapeHtml(entry.label)}</div>
          <div class="small muted">${escapeHtml(entry.key)}</div>
        </div>
        <div class="row">
          <div>
            <span class="badge">${escapeHtml(maskValue(entry.key, entry.value))}</span>
            <div class="small muted">更新 ${escapeHtml(new Date(entry.updatedAt).toLocaleString("ja-JP"))}</div>
          </div>
          ${
            sensitive
              ? `<form method="post" action="/profile/reveal" class="actions">
            ${this.csrfInput()}
            <input type="hidden" name="key" value="${escapeHtml(entry.key)}">
            <input name="passphrase" type="password" autocomplete="current-password" placeholder="パスフレーズ" required>
            <button type="submit" class="secondary">表示</button>
          </form>`
              : ""
          }
        </div>
      </div>
    `;
  }

  private renderProfileEditForm(entries: ProfileEntry[]): string {
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    const knownFields = KNOWN_PROFILE_KEYS.map((key) => {
      const entry = byKey.get(key);
      const sensitive = isSensitiveKey(key);
      const value = !sensitive && entry ? entry.value : "";
      const placeholder = sensitive && entry ? "設定済み。変更する場合だけ入力" : "";
      return `
        <label>${escapeHtml(PROFILE_FIELD_LABELS[key])}
          <input name="profile.${escapeHtml(key)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off">
        </label>
      `;
    }).join("");
    const customEntries = entries.filter((entry) => entry.key.startsWith("custom."));
    return `
      <form class="stack" method="post" action="/profile/save-all">
        ${this.csrfInput()}
        <h3>基本項目</h3>
        <div class="profile-grid">
          ${knownFields}
        </div>
        <h3>カスタム項目</h3>
        ${
          customEntries.length === 0
            ? `<div class="empty">カスタム項目はまだありません。</div>`
            : customEntries
                .map(
                  (entry) => `
                    <div class="item-card">
                      <input type="hidden" name="customExistingKey" value="${escapeHtml(entry.key)}">
                      <div class="cols">
                        <label>ラベル
                          <input name="customExistingLabel" value="${escapeHtml(entry.label)}">
                        </label>
                        <label>値
                          <input name="customExistingValue" value="${escapeHtml(entry.value)}" autocomplete="off">
                        </label>
                      </div>
                      <label>マッチング用語
                        <input name="customExistingTerms" value="${escapeHtml(entry.matchTerms?.join(", ") ?? "")}">
                      </label>
                    </div>
                  `,
                )
                .join("")
        }
        <div class="item-card">
          <h3>カスタム項目を追加</h3>
          <div class="cols">
            <label>キー
              <input name="customSlug" pattern="[A-Za-z0-9_-]+" placeholder="例: occupation">
            </label>
            <label>ラベル
              <input name="customLabel" placeholder="例: 職業">
            </label>
          </div>
          <label>値
            <input name="customValue" autocomplete="off">
          </label>
          <label>マッチング用語（カンマ区切り）
            <input name="customTerms" placeholder="例: 職業, ご職業">
          </label>
        </div>
        <div class="form-footer">
          <button type="submit">保存</button>
        </div>
      </form>
    `;
  }

  private renderSitesSection(records: SiteRecord[], candidates: { record: SiteRecord; stale: ReturnType<typeof staleFilledFields> }[]): string {
    return `
      <section id="sites" class="panel">
        <div class="section-header">
          <div>
            <h2>登録済みサイト</h2>
            <p class="muted">新規登録と一括更新は、このページ上部から開始できます。</p>
          </div>
        </div>
        <div class="site-action-grid">
          ${this.renderRegistrationAction()}
          ${this.renderBulkAction(candidates)}
        </div>
        <div class="item-list">
          ${records.length === 0 ? `<div class="empty">登録済みサイトはまだありません。</div>` : records.map((record) => this.renderSiteRecord(record)).join("")}
        </div>
      </section>
    `;
  }

  private renderRegistrationAction(): string {
    return `
      <form class="action-panel stack" method="post" action="/registration/start">
        ${this.csrfInput()}
        <h3>新規登録</h3>
        <p class="muted">登録したいサイトのURLを入力します。</p>
        <label>サイトURL
          <input name="url" type="url" placeholder="example.com/register">
        </label>
        <button type="submit">新規登録を開始</button>
      </form>
    `;
  }

  private renderBulkAction(candidates: { record: SiteRecord; stale: ReturnType<typeof staleFilledFields> }[]): string {
    return `
      <form class="action-panel stack" method="post" action="/bulk/start">
        ${this.csrfInput()}
        <h3>一括更新</h3>
        <p class="muted">更新候補 ${escapeHtml(candidates.length)} 件。保存済み情報との差分があるサイトをまとめて更新します。</p>
        <button type="submit" ${candidates.length === 0 ? "disabled" : ""}>一括更新を開始</button>
      </form>
    `;
  }

  private renderSiteRecord(record: SiteRecord): string {
    const stale = staleFilledFields(this.app.store, record);
    const labels = stale.map((field) => this.app.store.profile.get(field.profileKey)?.label ?? field.profileKey);
    const mandates = this.app.store.listMandates(record.origin);
    return `
      <article class="item-card">
        <div class="row">
          <div>
            <h3>${escapeHtml(record.serviceName)}</h3>
            <div class="small muted">${escapeHtml(record.origin)} · ${escapeHtml(new Date(record.registeredAt).toLocaleString("ja-JP"))}</div>
          </div>
          <div class="actions">
            <span class="badge">${escapeHtml(record.status)}</span>
            ${stale.length > 0 ? `<span class="badge warn">更新候補 ${stale.length}</span>` : ""}
          </div>
        </div>
        <p class="small muted">送信済み項目: ${escapeHtml(record.filledFields.length)} / mandate: ${escapeHtml(mandates.length)}</p>
        ${labels.length > 0 ? `<p class="small">差分: ${escapeHtml(labels.join(", "))}</p>` : ""}
      </article>
    `;
  }

  private renderSettingsSection(settings: ProviderSettings | undefined): string {
    return `
      <section id="settings" class="panel">
        <h2>設定</h2>
        <div class="grid two">
          <form class="stack" method="post" action="/settings/provider">
            ${this.csrfInput()}
            <h3>AIプロバイダー</h3>
            <p class="muted">APIキーは暗号化ストアに保存します。AIにはフォーム構造と規約テキストだけを送ります。</p>
            <label>プロバイダー
              <select name="provider" required>
                <option value="">選択してください</option>
                <option value="openai" ${settings?.provider === "openai" ? "selected" : ""}>OpenAI</option>
                <option value="anthropic" ${settings?.provider === "anthropic" ? "selected" : ""}>Anthropic</option>
              </select>
            </label>
            <label>モデル
              <input name="model" value="${escapeHtml(settings?.model ?? "")}" required>
            </label>
            <label>APIキー
              <input name="apiKey" type="password" autocomplete="off" ${settings ? `placeholder="設定済み。変更時だけ入力"` : "required"}>
            </label>
            <button type="submit">保存</button>
          </form>
          <div class="stack">
            <form class="panel stack" method="post" action="/settings/reveal-api-key">
              ${this.csrfInput()}
              <h3>APIキー表示</h3>
              <p class="muted">${settings ? `${escapeHtml(settings.provider)} / ${escapeHtml(settings.model)} が設定済みです。` : "AIプロバイダーは未設定です。"}</p>
              <label>マスターパスフレーズ
                <input name="passphrase" type="password" autocomplete="current-password" required>
              </label>
              <button type="submit" class="secondary" ${settings ? "" : "disabled"}>APIキーを表示</button>
            </form>
            ${this.renderRecoveryControls()}
          </div>
        </div>
      </section>
    `;
  }

  private renderRecoveryControls(): string {
    const hasRecovery = this.app.store.hasRecoveryKey;
    return `
      <div class="panel stack">
        <h3>リカバリーキー</h3>
        <p class="muted">状態: ${hasRecovery ? "設定済み" : "未設定"}。生成したキーは一度だけ表示されます。</p>
        <div class="actions">
          <form method="post" action="/recovery/generate">
            ${this.csrfInput()}
            <button type="submit" class="secondary">${hasRecovery ? "再生成" : "生成"}</button>
          </form>
          <form method="post" action="/recovery/remove">
            ${this.csrfInput()}
            <button type="submit" class="danger" ${hasRecovery ? "" : "disabled"}>削除</button>
          </form>
        </div>
        <form class="stack" method="post" action="/recovery/verify">
          ${this.csrfInput()}
          <label>リカバリーキー検証
            <input name="recoveryKey" type="password" autocomplete="off">
          </label>
          <button type="submit" class="secondary" ${hasRecovery ? "" : "disabled"}>検証</button>
        </form>
      </div>
    `;
  }

  private async unlock(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const passphrase = formValue(form, "passphrase");
    if (!passphrase) {
      this.redirect(res, "error", "パスフレーズを入力してください。");
      return;
    }
    try {
      await this.app.unlock(passphrase);
      this.redirect(res, "ok", "暗号化ストアを開きました。", "profile");
    } catch (err) {
      const message = err instanceof AutofillAppError ? err.message : "ストアを開けませんでした。";
      this.redirect(res, "error", message, "profile");
    }
  }

  private async unlockWithRecovery(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const recoveryKey = formValue(form, "recoveryKey");
    if (!recoveryKey) {
      this.redirect(res, "error", "リカバリーキーを入力してください。");
      return;
    }
    try {
      await this.app.unlockWithRecoveryKey(recoveryKey);
      this.redirect(res, "ok", "リカバリーキーで開きました。", "profile");
    } catch (err) {
      const message = err instanceof AutofillAppError ? err.message : "リカバリーキーで開けませんでした。";
      this.redirect(res, "error", message, "profile");
    }
  }

  private async saveProfile(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const store = this.app.store;
    let key = asProfileKey(formValue(form, "key"));
    let label = formValue(form, "label");
    let matchTerms = splitTerms(formValue(form, "matchTerms"));

    if (!key) {
      const customSlug = formValue(form, "customSlug");
      if (customSlug) {
        if (!/^[a-zA-Z0-9_-]+$/.test(customSlug)) {
          this.redirect(res, "error", "カスタムキーは英数字・ハイフン・アンダースコアだけで入力してください。");
          return;
        }
        key = `custom.${customSlug}`;
        label = formValue(form, "customLabel");
        if (!label) {
          this.redirect(res, "error", "カスタム項目にはラベルが必要です。");
          return;
        }
        matchTerms ??= [label];
      } else {
        const knownKey = asKnownProfileKey(formValue(form, "knownKey"));
        if (!knownKey) {
          this.redirect(res, "error", "保存するフィールドを選択してください。");
          return;
        }
        key = knownKey;
        label = PROFILE_FIELD_LABELS[knownKey];
      }
    } else {
      const existing = store.profile.get(key);
      label ||= existing?.label ?? profileLabel(key);
      matchTerms ??= existing?.matchTerms;
    }

    const value = formValue(form, "value");
    if (!value) {
      this.redirect(res, "error", "値を入力してください。");
      return;
    }

    store.setProfileValue(key, label, value, matchTerms);
    await store.save();
    this.redirect(res, "ok", "個人情報を保存しました。", "profile");
  }

  private async saveAllProfile(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const store = this.app.store;
    for (const key of KNOWN_PROFILE_KEYS) {
      const value = formValue(form, `profile.${key}`);
      const existing = store.profile.get(key);
      if (value) {
        store.setProfileValue(key, PROFILE_FIELD_LABELS[key], value, existing?.matchTerms);
      } else if (existing && !isSensitiveKey(key)) {
        store.deleteProfileValue(key);
      }
    }

    const customKeys = form.getAll("customExistingKey").map((value) => value.trim());
    const customLabels = form.getAll("customExistingLabel").map((value) => value.trim());
    const customValues = form.getAll("customExistingValue").map((value) => value.trim());
    const customTerms = form.getAll("customExistingTerms").map((value) => value.trim());
    for (const [index, rawKey] of customKeys.entries()) {
      const key = asProfileKey(rawKey);
      if (!key || !key.startsWith("custom.")) continue;
      const label = customLabels[index] || store.profile.get(key)?.label || key;
      const value = customValues[index] ?? "";
      if (value) {
        store.setProfileValue(key, label, value, splitTerms(customTerms[index] ?? "") ?? [label]);
      } else {
        store.deleteProfileValue(key);
      }
    }

    const customSlug = formValue(form, "customSlug");
    const customLabel = formValue(form, "customLabel");
    const customValue = formValue(form, "customValue");
    if (customSlug || customLabel || customValue) {
      if (!customSlug || !/^[a-zA-Z0-9_-]+$/.test(customSlug)) {
        this.redirect(res, "error", "追加するカスタムキーは英数字・ハイフン・アンダースコアだけで入力してください。", "profile", "edit");
        return;
      }
      if (!customLabel || !customValue) {
        this.redirect(res, "error", "カスタム項目を追加する場合はラベルと値を入力してください。", "profile", "edit");
        return;
      }
      const key: ProfileKey = `custom.${customSlug}`;
      store.setProfileValue(key, customLabel, customValue, splitTerms(formValue(form, "customTerms")) ?? [customLabel]);
    }

    await store.save();
    this.redirect(res, "ok", "個人情報をまとめて保存しました。", "profile");
  }

  private async deleteProfile(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const key = asProfileKey(formValue(form, "key"));
    if (!key) {
      this.redirect(res, "error", "削除するフィールドが不正です。");
      return;
    }
    this.app.store.deleteProfileValue(key);
    await this.app.store.save();
    this.redirect(res, "ok", "個人情報を削除しました。", "profile");
  }

  private async revealProfile(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const key = asProfileKey(formValue(form, "key"));
    if (!key) {
      this.redirect(res, "error", "表示するフィールドが不正です。");
      return;
    }
    const entry = this.app.store.profile.get(key);
    if (!entry) {
      this.redirect(res, "error", "フィールドが見つかりません。");
      return;
    }
    if (isSensitiveKey(key)) {
      const passphrase = formValue(form, "passphrase");
      if (!passphrase || !(await this.app.store.verifyPassphrase(passphrase))) {
        this.redirect(res, "error", "パスフレーズが一致しません。表示を中止しました。", "profile");
        return;
      }
    }
    this.sendHtml(res, 200, this.renderHome(undefined, { label: `${entry.label} [${entry.key}]`, value: entry.value }, { tab: "profile", profileMode: "view" }));
  }

  private async saveProviderSettings(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const provider = formValue(form, "provider");
    if (provider !== "openai" && provider !== "anthropic") {
      this.redirect(res, "error", "AIプロバイダーを選択してください。");
      return;
    }
    const model = formValue(form, "model");
    if (!model) {
      this.redirect(res, "error", "モデル名を入力してください。");
      return;
    }
    const existing = this.app.store.getSettings();
    const apiKey = formValue(form, "apiKey") || existing?.apiKey;
    if (!apiKey) {
      this.redirect(res, "error", "APIキーを入力してください。");
      return;
    }
    this.app.store.setProviderSettings({ provider, model, apiKey });
    await this.app.store.save();
    this.redirect(res, "ok", "AIプロバイダー設定を保存しました。", "settings");
  }

  private async revealApiKey(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const settings = this.app.store.getSettings();
    if (!settings) {
      this.redirect(res, "error", "AIプロバイダーは未設定です。");
      return;
    }
    const passphrase = formValue(form, "passphrase");
    if (!passphrase || !(await this.app.store.verifyPassphrase(passphrase))) {
      this.redirect(res, "error", "パスフレーズが一致しません。表示を中止しました。", "settings");
      return;
    }
    this.sendHtml(res, 200, this.renderHome(undefined, { label: `${settings.provider} API key`, value: settings.apiKey }, { tab: "settings", profileMode: "view" }));
  }

  private async generateRecoveryKey(res: ServerResponse): Promise<void> {
    const recoveryKey = await this.app.store.setupRecoveryKey();
    await this.app.store.save();
    this.sendHtml(
      res,
      200,
      this.renderHome(undefined, {
        label: "リカバリーキー",
        value: recoveryKey,
        warning: "このキーはこの画面で一度だけ表示されます。安全な場所に保管し、AIやチャットに貼り付けないでください。",
      }, { tab: "settings", profileMode: "view" }),
    );
  }

  private async verifyRecoveryKey(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const recoveryKey = formValue(form, "recoveryKey");
    const ok = recoveryKey ? await this.app.store.verifyRecoveryKey(recoveryKey) : false;
    this.redirect(res, ok ? "ok" : "error", ok ? "リカバリーキーを確認しました。" : "リカバリーキーが一致しません。", "settings");
  }

  private async removeRecoveryKey(res: ServerResponse): Promise<void> {
    if (!this.app.store.hasRecoveryKey) {
      this.redirect(res, "warn", "リカバリーキーは設定されていません。", "settings");
      return;
    }
    this.app.store.removeRecoveryKey();
    await this.app.store.save();
    this.redirect(res, "ok", "リカバリーキーを削除しました。", "settings");
  }
}

export function startWebUiServer(options: WebUiServerOptions): Promise<WebUiServerHandle> {
  return new WebUiServer(options).start();
}
