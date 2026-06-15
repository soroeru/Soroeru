// Local browser UI shell for Issue #66.
//
// This is intentionally server-rendered over Node's built-in HTTP server for
// the first implementation slice: no new frontend framework, no telemetry, and
// no remote backend. The server binds to 127.0.0.1 by default and all writes go
// through CatashiroApp/PocStore so encrypted-at-rest behavior stays unchanged.

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { maskValue } from "../agent/gate.js";
import { deriveAccountState, nextActionForAccountState, staleFilledFields } from "../agent/records.js";
import { PROFILE_FIELD_INPUT, validateProfileValue } from "../profile.js";
import {
  isSensitiveKey,
  KNOWN_PROFILE_KEYS,
  MOST_SENSITIVE_KEY,
  PROFILE_FIELD_LABELS,
  type KnownProfileKey,
  type ProfileKey,
  type SiteRecord,
} from "../types.js";
import type { PocStore, ProfileEntry, ProviderSettings } from "../store/store.js";
import { CatashiroApp, CatashiroAppError } from "./app.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4127;
const FORM_LIMIT_BYTES = 128 * 1024;
const URL_BASE = "http" + "://127.0.0.1";
/** Minimum master-passphrase length enforced on first-run vault setup (#79). */
const MIN_PASSPHRASE_LENGTH = 8;

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
  app: CatashiroApp;
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

const ICON_LOCK =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';

const BRAND_MARK =
  '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="#1f5f8b"></rect><path d="M12 6v8m0 0-3.5-3.5M12 14l3.5-3.5" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path><path d="M7 18h10" stroke="#ffffff" stroke-width="2" stroke-linecap="round"></path></svg>';

class WebUiServer {
  private readonly app: CatashiroApp;
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
      const hasVault = this.app.isUnlocked || (await this.app.hasVault());
      this.sendHtml(res, 200, this.renderHome(this.flashFromQuery(url.searchParams), undefined, this.pageState(url.searchParams), hasVault));
      return;
    }
    if (method !== "POST") throw new HttpError(404, "ページが見つかりません");

    const form = await readForm(req);
    this.assertCsrf(form);
    switch (url.pathname) {
      case "/setup":
        await this.setupVault(form, res);
        return;
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
      case "/chat/send":
        this.redirect(res, "warn", "チャットでの操作は今後実装予定です。");
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

  private renderHome(flash?: Flash, reveal?: Reveal, state: PageState = { tab: "profile", profileMode: "view" }, hasVault = true): string {
    if (!this.app.isUnlocked) return this.renderLocked(flash, hasVault);
    return this.renderUnlocked(flash, reveal, state);
  }

  private renderLocked(flash: Flash | undefined, hasVault: boolean): string {
    return this.renderLayout("Catashiro", hasVault ? this.renderUnlockPanels(flash) : this.renderSetupPanels(flash));
  }

  /** First-run onboarding: no encrypted store file exists yet (#79). */
  private renderSetupPanels(flash?: Flash): string {
    return `
      <section class="hero-band">
        <div>
          <p class="eyebrow">Local-first Catashiro</p>
          <h1>Catashiro を開く</h1>
          <p>初めての起動です。この画面はあなたのPC上だけで動きます。個人情報は暗号化して保存し、クラウド同期やテレメトリは使いません。</p>
        </div>
      </section>
      ${this.renderFlash(flash)}
      <section class="grid two">
        <form class="panel" method="post" action="/setup">
          ${this.csrfInput()}
          <h2>マスターパスフレーズを設定</h2>
          <p class="muted">ここで決めた言葉が今後の暗号化の鍵になります。${MIN_PASSPHRASE_LENGTH}文字以上で、忘れにくく他人に推測されにくい言葉にしてください。</p>
          <label>パスフレーズ
            <input name="passphrase" type="password" autocomplete="new-password" minlength="${MIN_PASSPHRASE_LENGTH}" required>
          </label>
          <label>パスフレーズ（確認）
            <input name="confirmPassphrase" type="password" autocomplete="new-password" minlength="${MIN_PASSPHRASE_LENGTH}" required>
          </label>
          <button type="submit">保管庫を作成して開く</button>
        </form>
        <div class="panel stack">
          <h2>保存場所</h2>
          <p class="muted">個人情報はこのPC内に暗号化して保存されます。</p>
          <p class="small"><code>${escapeHtml(this.app.storeFilePath)}</code></p>
          <h2>パスフレーズを忘れた場合</h2>
          <p class="muted">パスフレーズを忘れると、リカバリーキー（保管庫を作成した後に設定画面で生成できます）がない限り、保存した個人情報は復元できません。リカバリーキーは外部に送信されず、このPC上にのみ表示されます。</p>
        </div>
      </section>
    `;
  }

  /** Returning user: an encrypted store file exists; unlock with passphrase or recovery key. */
  private renderUnlockPanels(flash?: Flash): string {
    return `
      <section class="hero-band">
        <div>
          <p class="eyebrow">Local-first Catashiro</p>
          <h1>Catashiro を開く</h1>
          <p>この画面はあなたのPC上だけで動きます。個人情報は暗号化して保存し、クラウド同期やテレメトリは使いません。</p>
        </div>
      </section>
      ${this.renderFlash(flash)}
      <section class="grid two">
        <form class="panel" method="post" action="/unlock">
          ${this.csrfInput()}
          <h2>マスターパスフレーズ</h2>
          <p class="muted">保管庫を作成したときに設定した言葉を入力してください。</p>
          <label>パスフレーズ
            <input name="passphrase" type="password" autocomplete="current-password" required>
          </label>
          <button type="submit">開く</button>
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
      <p class="muted small">パスフレーズとリカバリーキーの両方が分からない場合、保存されている個人情報を復元する方法はありません。</p>
    `;
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
      "Catashiro dashboard",
      `
        <header class="app-header">
          <div>
            <p class="eyebrow">Local web app</p>
            <h1>Catashiro</h1>
            ${this.renderIdleLockNote()}
          </div>
          <form method="post" action="/lock">
            ${this.csrfInput()}
            <button type="submit" class="secondary">ロック</button>
          </form>
        </header>
        ${this.renderFlash(flash)}
        ${this.renderReveal(reveal)}
        ${this.renderRecoveryReminder(store)}
        ${this.renderAttention(updateCandidates)}
        ${this.renderStats(profile.length, sites.length, settings)}
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
      /* Primary: steel blue */
      --blue-50: #eef4f9;
      --blue-100: #d6e5f0;
      --blue-200: #aecbe0;
      --blue-400: #4985ac;
      --blue-500: #1f5f8b;
      --blue-600: #195175;
      --blue-700: #163f5a;
      /* Neutral: cool slate */
      --neutral-0: #ffffff;
      --neutral-25: #fafbfc;
      --neutral-50: #f6f7f9;
      --neutral-100: #eef0f4;
      --neutral-200: #d9dee7;
      --neutral-300: #c1c7d0;
      --neutral-500: #6b7480;
      --neutral-600: #4d5560;
      --neutral-900: #202124;
      /* Signal colors */
      --green-50: #e9f5ef;
      --green-100: #cde9dc;
      --green-600: #0f6243;
      --amber-50: #fdf3e3;
      --amber-100: #f9e3c2;
      --amber-700: #6f3f0a;
      --red-50: #fcece9;
      --red-100: #f7d3cd;
      --red-500: #c4392a;
      --red-600: #a82317;
      /* Semantic aliases */
      --bg-app: var(--neutral-50);
      --surface-card: var(--neutral-0);
      --surface-sunken: var(--neutral-25);
      --surface-accent-soft: var(--blue-50);
      --border-subtle: var(--neutral-200);
      --border-strong: var(--neutral-300);
      --border-focus: var(--blue-400);
      --text-primary: var(--neutral-900);
      --text-secondary: var(--neutral-600);
      --text-muted: var(--neutral-500);
      --text-accent: var(--blue-600);
      --text-link: var(--blue-600);
      --action-primary-bg: var(--blue-500);
      --action-primary-bg-hover: var(--blue-600);
      --action-primary-bg-press: var(--blue-700);
      --action-primary-fg: var(--neutral-0);
      --action-secondary-bg: var(--neutral-0);
      --action-secondary-bg-hover: var(--neutral-100);
      --action-secondary-border: var(--neutral-300);
      --action-secondary-fg: var(--neutral-900);
      --action-danger-bg: var(--red-500);
      --action-danger-bg-hover: var(--red-600);
      --action-danger-fg: var(--neutral-0);
      --status-safe-fg: var(--green-600);
      --status-safe-bg: var(--green-50);
      --status-safe-border: var(--green-100);
      --status-risk-fg: var(--amber-700);
      --status-risk-bg: var(--amber-50);
      --status-risk-border: var(--amber-100);
      --status-blocked-fg: var(--red-600);
      --status-blocked-bg: var(--red-50);
      --status-blocked-border: var(--red-100);
      --lock-accent: var(--blue-700);
      --ring: 0 0 0 3px color-mix(in srgb, var(--blue-400) 45%, transparent);
      /* Spacing (4px grid) */
      --space-2: 4px;
      --space-3: 8px;
      --space-4: 12px;
      --space-5: 16px;
      --space-6: 20px;
      --space-7: 24px;
      --space-9: 40px;
      /* Radii & sizing */
      --radius-sm: 6px;
      --radius-md: 8px;
      --radius-pill: 999px;
      --control-height-md: 34px;
      --container-max: 1080px;
      --rail-width: 360px;
      /* Type (fallback stack only - no external font loads) */
      --font-sans: -apple-system, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", "Segoe UI", system-ui, sans-serif;
      --font-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--font-sans);
      background: var(--bg-app);
      color: var(--text-primary);
      line-height: 1.5;
      font-size: 14px;
    }
    a { color: var(--text-link); }
    h1, h2, h3 { margin: 0; line-height: 1.2; font-weight: 600; }
    h1 { font-size: 1.6rem; }
    h2 { font-size: 1.15rem; }
    h3 { font-size: 1rem; }
    /* Window shell */
    .win { min-height: 100vh; display: flex; flex-direction: column; }
    .win__bar {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-5);
      background: var(--surface-card);
      border-bottom: 1px solid var(--border-subtle);
      font-weight: 600;
    }
    .win__bar svg { color: var(--lock-accent); flex: none; }
    .win__body { flex: 1; display: flex; min-height: 0; }
    .canvas { flex: 1; min-width: 0; }
    .canvas--locked { background: radial-gradient(ellipse 60% 50% at 50% 0%, var(--surface-accent-soft), transparent 70%); }
    /* Chat rail (visual only) */
    .rail {
      width: var(--rail-width);
      flex: none;
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      padding: var(--space-5);
      background: var(--surface-card);
      border-right: 1px solid var(--border-subtle);
    }
    .rail__brand { display: flex; align-items: center; gap: var(--space-3); }
    .rail__brand strong { display: block; }
    .rail__status { display: flex; align-items: center; gap: var(--space-2); color: var(--text-secondary); font-size: .82rem; margin-top: 2px; }
    .dot { width: 8px; height: 8px; border-radius: var(--radius-pill); display: inline-block; }
    .dot--safe { background: var(--status-safe-fg); }
    .rail__intro { margin: 0; font-size: .88rem; }
    .thread { display: grid; gap: var(--space-3); }
    .bubble { border-radius: var(--radius-md); padding: var(--space-4); font-size: .88rem; }
    .bubble--ai { background: var(--surface-sunken); border: 1px solid var(--border-subtle); }
    .chips { display: flex; flex-wrap: wrap; gap: var(--space-2); }
    .chip-form { display: inline-flex; }
    .chip {
      border-radius: var(--radius-pill);
      border: 1px solid var(--border-subtle);
      background: var(--surface-card);
      color: var(--text-secondary);
      padding: var(--space-2) var(--space-4);
      font-size: .8rem;
      font-weight: 600;
      height: auto;
    }
    .chip:hover { background: var(--neutral-100); }
    .inputrow { display: flex; gap: var(--space-2); margin-top: auto; }
    .inputrow input { flex: 1; }
    main { width: min(var(--container-max), calc(100% - 48px)); margin: 0 auto; padding: var(--space-7) 0 var(--space-9); }
    .hero-band, .app-header {
      background: var(--surface-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: var(--space-7);
      margin-bottom: var(--space-5);
    }
    .hero-band { background: linear-gradient(180deg, var(--surface-accent-soft), var(--surface-card)); }
    .hero-band p { max-width: 760px; }
    .app-header { display: flex; justify-content: space-between; align-items: center; gap: var(--space-5); }
    .eyebrow { margin: 0 0 6px; color: var(--text-accent); font-size: .78rem; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
    .muted { color: var(--text-muted); }
    .grid { display: grid; gap: var(--space-5); }
    .grid.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    /* Attention banner */
    .attn {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-subtle);
      padding: var(--space-5);
      margin: var(--space-5) 0;
    }
    .attn--risk { background: var(--status-risk-bg); border-color: var(--status-risk-border); color: var(--status-risk-fg); }
    .attn--calm { background: var(--status-safe-bg); border-color: var(--status-safe-border); color: var(--status-safe-fg); }
    .attn p { margin: 4px 0 0; color: inherit; opacity: .85; }
    /* Stats */
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-4); margin: var(--space-5) 0; }
    .stat {
      background: var(--surface-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: var(--space-5);
      display: grid;
      gap: 4px;
    }
    .stat__label, .stat__help { color: var(--text-muted); font-size: .8rem; }
    .stat__value { font-size: 1.3rem; font-weight: 600; }
    .panel, .item-card {
      background: var(--surface-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
    }
    .panel { padding: var(--space-6); margin: var(--space-5) 0; box-shadow: 0 1px 2px rgba(32, 33, 36, .04); }
    .panel > h2 { margin-bottom: var(--space-4); }
    .item-list { display: grid; gap: var(--space-3); }
    .item-card { padding: var(--space-4); display: grid; gap: var(--space-4); }
    .row { display: flex; justify-content: space-between; align-items: start; gap: var(--space-4); flex-wrap: wrap; }
    .actions { display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: end; }
    /* Tabs */
    .tabs { display: flex; gap: var(--space-5); border-bottom: 1px solid var(--border-subtle); margin: var(--space-5) 0; }
    .tabs a {
      display: inline-flex;
      padding: var(--space-3) 0;
      text-decoration: none;
      color: var(--text-secondary);
      font-weight: 600;
      border-bottom: 2px solid transparent;
    }
    .tabs a.active { color: var(--text-accent); border-bottom-color: var(--blue-500); }
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      flex-wrap: wrap;
      margin-bottom: var(--space-4);
    }
    .section-header h2 { margin: 0; }
    /* Sites */
    .site-action-grid { display: grid; gap: var(--space-4); margin-bottom: var(--space-5); }
    .reghero {
      background: linear-gradient(135deg, var(--surface-accent-soft), var(--surface-card));
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: var(--space-6);
    }
    .callout {
      border-radius: var(--radius-md);
      border: 1px solid var(--border-subtle);
      padding: var(--space-5);
      margin-bottom: var(--space-5);
    }
    .callout--risk { background: var(--status-risk-bg); border-color: var(--status-risk-border); }
    .callout--risk h3, .callout--risk p { color: var(--status-risk-fg); }
    .action-panel {
      background: var(--surface-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: var(--space-4);
    }
    .profile-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-4);
    }
    .profile-row {
      display: grid;
      grid-template-columns: minmax(120px, 220px) minmax(0, 1fr);
      gap: var(--space-3);
      align-items: center;
      padding: var(--space-3) 0;
      border-bottom: 1px solid var(--border-subtle);
    }
    .profile-row:last-child { border-bottom: 0; }
    .profile-label { font-weight: 600; }
    .mask { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); }
    .mask svg { width: 12px; height: 12px; color: var(--text-muted); flex: none; }
    .form-footer {
      display: flex;
      justify-content: flex-end;
      padding-top: var(--space-5);
      margin-top: var(--space-3);
      border-top: 1px solid var(--border-subtle);
    }
    form.stack, .stack { display: grid; gap: var(--space-4); align-content: start; }
    label { display: grid; gap: 5px; font-weight: 600; font-size: .9rem; }
    .field { display: grid; gap: 5px; }
    .field-delete {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 400;
      color: var(--text-muted);
    }
    input[type="checkbox"] { width: auto; height: auto; }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      padding: 8px 11px;
      font: inherit;
      background: var(--surface-card);
      color: var(--text-primary);
      height: var(--control-height-md);
    }
    textarea { min-height: 72px; height: auto; resize: vertical; }
    input:focus, select:focus, textarea:focus, button:focus-visible, .chip:focus-visible {
      outline: none;
      box-shadow: var(--ring);
      border-color: var(--border-focus);
    }
    button, .button {
      border: 0;
      border-radius: var(--radius-sm);
      background: var(--action-primary-bg);
      color: var(--action-primary-fg);
      padding: 9px 14px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: var(--control-height-md);
    }
    button:hover, .button:hover { background: var(--action-primary-bg-hover); }
    button.secondary, .button.secondary {
      background: var(--action-secondary-bg);
      color: var(--action-secondary-fg);
      border: 1px solid var(--action-secondary-border);
    }
    button.secondary:hover, .button.secondary:hover { background: var(--action-secondary-bg-hover); }
    button.danger { background: var(--action-danger-bg); color: var(--action-danger-fg); }
    button.danger:hover { background: var(--action-danger-bg-hover); }
    button:disabled { opacity: .45; cursor: not-allowed; }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: var(--radius-pill);
      padding: 3px 10px;
      background: var(--neutral-100);
      color: var(--text-secondary);
      font-size: .78rem;
      font-weight: 600;
    }
    .badge.warn { color: var(--status-risk-fg); background: var(--status-risk-bg); }
    .flash, .reveal {
      border-radius: var(--radius-md);
      padding: var(--space-4) var(--space-5);
      margin: var(--space-4) 0;
      border: 1px solid var(--border-subtle);
      background: var(--surface-card);
    }
    .flash.ok { border-color: var(--status-safe-border); color: var(--status-safe-fg); background: var(--status-safe-bg); }
    .flash.warn { border-color: var(--status-risk-border); color: var(--status-risk-fg); background: var(--status-risk-bg); }
    .flash.error, .panel.error { border-color: var(--status-blocked-border); color: var(--status-blocked-fg); background: var(--status-blocked-bg); }
    .reveal code {
      display: block;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--surface-sunken);
      color: var(--text-primary);
      font-family: var(--font-mono);
      padding: var(--space-4);
      border-radius: var(--radius-sm);
      margin-top: var(--space-3);
    }
    details { border-top: 1px solid var(--border-subtle); padding-top: var(--space-3); }
    summary { cursor: pointer; font-weight: 600; }
    .empty { padding: var(--space-5); border: 1px dashed var(--border-strong); border-radius: var(--radius-md); color: var(--text-muted); }
    .cols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
    .small { font-size: .85rem; }
    @media (max-width: 820px) {
      .rail { display: none; }
      main { width: min(100% - 20px, 680px); padding-top: var(--space-4); }
      .grid.two, .stats, .cols { grid-template-columns: 1fr; }
      .site-action-grid, .profile-grid, .profile-row { grid-template-columns: 1fr; }
      .app-header { align-items: stretch; }
      .app-header form { width: 100%; }
      .app-header button { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="win">
    <div class="win__bar">
      ${ICON_LOCK}
      <span>Catashiro — ローカルアプリ</span>
    </div>
    <div class="win__body">
      ${this.app.isUnlocked ? this.renderChatRail() : ""}
      <div class="canvas${this.app.isUnlocked ? "" : " canvas--locked"}">
        <main>
          ${body}
        </main>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  private renderChatRail(): string {
    return `
      <aside class="rail" aria-label="チャット">
        <div class="rail__brand">
          ${BRAND_MARK}
          <div>
            <strong>Catashiro</strong>
            <div class="rail__status"><span class="dot dot--safe"></span>ローカルで実行中</div>
          </div>
        </div>
        <p class="rail__intro muted">言葉で指示すると、保存済みの情報でフォームを下書きします。送信は確認後のみ。</p>
        <div class="thread">
          <div class="bubble bubble--ai">ロックを解除しました。登録や情報の更新を言葉で指示できます。送信前には必ず確認画面を出します。</div>
        </div>
        <div class="chips">
          <form class="chip-form" method="post" action="/chat/send">
            ${this.csrfInput()}
            <input type="hidden" name="message" value="ストリームプラスに登録">
            <button type="submit" class="chip">ストリームプラスに登録</button>
          </form>
          <form class="chip-form" method="post" action="/chat/send">
            ${this.csrfInput()}
            <input type="hidden" name="message" value="住所を更新して">
            <button type="submit" class="chip">住所を更新して</button>
          </form>
        </div>
        <form class="inputrow" method="post" action="/chat/send">
          ${this.csrfInput()}
          <input name="message" type="text" placeholder="登録や更新したい内容を入力" autocomplete="off">
          <button type="submit">送信</button>
        </form>
      </aside>
    `;
  }

  private renderFlash(flash?: Flash): string {
    if (!flash) return "";
    return `<div class="flash ${flash.kind}" role="status">${escapeHtml(flash.message)}</div>`;
  }

  private renderReveal(reveal?: Reveal): string {
    if (!reveal) return "";
    return `<section class="reveal" role="status"><strong>${escapeHtml(reveal.label)}</strong>${reveal.warning ? `<p class="muted">${escapeHtml(reveal.warning)}</p>` : ""}<code>${escapeHtml(reveal.value)}</code></section>`;
  }

  private renderIdleLockNote(): string {
    if (this.app.idleLockMs <= 0) return "";
    const minutes = Math.round(this.app.idleLockMs / 60000);
    return `<p class="muted small">操作がない場合は${minutes}分で自動的にロックされます。</p>`;
  }

  private renderRecoveryReminder(store: PocStore): string {
    if (store.hasRecoveryKey) return "";
    return `
      <div class="attn attn--risk" role="status">
        <div>
          <strong>リカバリーキーが未設定です</strong>
          <p>パスフレーズを忘れた場合、リカバリーキーがないと保存した個人情報を復元できません。設定画面で生成できます。</p>
        </div>
        <a class="button secondary" href="/?tab=settings">設定を開く</a>
      </div>
    `;
  }

  private renderAttention(updateCandidates: { record: SiteRecord; stale: ReturnType<typeof staleFilledFields> }[]): string {
    if (updateCandidates.length > 0) {
      return `
        <div class="attn attn--risk" role="status">
          <div>
            <strong>更新候補が${escapeHtml(updateCandidates.length)}件あります</strong>
            <p>保存済み情報との差分があるサイトがあります。一括更新で反映できます。</p>
          </div>
          <a class="button secondary" href="/?tab=sites">一括更新を確認</a>
        </div>
      `;
    }
    return `
      <div class="attn attn--calm" role="status">
        <div>
          <strong>すべて最新です</strong>
          <p>登録済みサイトに保存済み情報との差分はありません。</p>
        </div>
      </div>
    `;
  }

  private renderStats(profileCount: number, siteCount: number, settings: ProviderSettings | undefined): string {
    return `
      <section class="stats" aria-label="概要">
        ${this.stat("個人情報", `${profileCount}`, "保存済みフィールド")}
        ${this.stat("登録済みサイト", `${siteCount}`, "保存済みサイト")}
        ${this.stat("AI設定", settings ? settings.provider : "未設定", settings?.model ?? "APIキーは暗号化保存")}
      </section>
    `;
  }

  private stat(label: string, value: string, help: string): string {
    return `<div class="stat"><span class="stat__label">${escapeHtml(label)}</span><strong class="stat__value">${escapeHtml(value)}</strong><span class="stat__help">${escapeHtml(help)}</span></div>`;
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
            <span class="badge mask">${sensitive ? ICON_LOCK : ""}${escapeHtml(maskValue(entry.key, entry.value))}</span>
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
      const input = PROFILE_FIELD_INPUT[key];
      const placeholder = sensitive && entry ? `設定済み。変更する場合だけ入力${input?.hint ? `（${input.hint}）` : ""}` : input?.hint ?? "";
      const typeAttr = input?.type ? ` type="${escapeHtml(input.type)}"` : "";
      const inputModeAttr = input?.inputmode ? ` inputmode="${escapeHtml(input.inputmode)}"` : "";
      const patternAttr = input?.pattern ? ` pattern="${escapeHtml(input.pattern)}"` : "";
      const deleteCheckbox = entry
        ? `<label class="field-delete small"><input type="checkbox" name="deleteKeys" value="${escapeHtml(key)}"> この項目を削除</label>`
        : "";
      return `
        <div class="field">
          <label>${escapeHtml(PROFILE_FIELD_LABELS[key])}
            <input name="profile.${escapeHtml(key)}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"${typeAttr}${inputModeAttr}${patternAttr} autocomplete="off">
          </label>
          ${deleteCheckbox}
        </div>
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
                      <label class="field-delete small"><input type="checkbox" name="customDeleteKeys" value="${escapeHtml(entry.key)}"> この項目を削除</label>
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
        </div>
        ${this.renderBulkAction(candidates)}
        <div class="item-list">
          ${records.length === 0 ? `<div class="empty">登録済みサイトはまだありません。</div>` : records.map((record) => this.renderSiteRecord(record)).join("")}
        </div>
      </section>
    `;
  }

  private renderRegistrationAction(): string {
    return `
      <form class="reghero stack" method="post" action="/registration/start">
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
    if (candidates.length === 0) {
      return `<p class="muted small">差分のあるサイトはありません。</p>`;
    }
    return `
      <form class="callout callout--risk stack" method="post" action="/bulk/start">
        ${this.csrfInput()}
        <h3>一括更新</h3>
        <p>更新候補 ${escapeHtml(candidates.length)} 件。保存済み情報との差分があるサイトをまとめて更新します。</p>
        <button type="submit">一括更新を開始</button>
      </form>
    `;
  }

  private renderSiteRecord(record: SiteRecord): string {
    const stale = staleFilledFields(this.app.store, record);
    const state = deriveAccountState(record, stale.length);
    const nextAction = nextActionForAccountState(state);
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
            <span class="badge">${escapeHtml(state)}</span>
            ${stale.length > 0 ? `<span class="badge warn">更新候補 ${stale.length}</span>` : ""}
          </div>
        </div>
        <p class="small muted">
          送信済み項目: ${escapeHtml(record.filledFields.length)} / mandate: ${escapeHtml(mandates.length)}
          / 最終確認: ${escapeHtml(new Date(record.lastCheckedAt ?? record.registeredAt).toLocaleString("ja-JP"))}
          / 次の操作: ${escapeHtml(nextAction)}
        </p>
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
        <p class="muted small">パスフレーズとリカバリーキーの両方を失うと、保存した個人情報は復元できません。生成したキーは安全な場所に保管してください。</p>
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
        <h3>保存場所</h3>
        <p class="muted small">個人情報はこのPC内の以下の場所に暗号化して保存されています。</p>
        <p class="small"><code>${escapeHtml(this.app.storeFilePath)}</code></p>
      </div>
    `;
  }

  /** First-run vault creation (#79): set the master passphrase (with confirmation) and create the encrypted store file. */
  private async setupVault(form: URLSearchParams, res: ServerResponse): Promise<void> {
    if (await this.app.hasVault()) {
      this.redirect(res, "error", "すでに保管庫が作成されています。パスフレーズで開いてください。");
      return;
    }
    const passphrase = formValue(form, "passphrase");
    const confirmPassphrase = formValue(form, "confirmPassphrase");
    if (!passphrase || !confirmPassphrase) {
      this.redirect(res, "error", "パスフレーズを2回入力してください。");
      return;
    }
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      this.redirect(res, "error", `パスフレーズは${MIN_PASSPHRASE_LENGTH}文字以上で入力してください。`);
      return;
    }
    if (passphrase !== confirmPassphrase) {
      this.redirect(res, "error", "確認用パスフレーズが一致しません。もう一度入力してください。");
      return;
    }
    await this.app.unlock(passphrase);
    await this.app.store.save();
    this.redirect(res, "ok", "保管庫を作成しました。続けてリカバリーキーを作成しておくことをおすすめします。", "settings");
  }

  private async unlock(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const passphrase = formValue(form, "passphrase");
    if (!passphrase) {
      this.redirect(res, "error", "パスフレーズを入力してください。");
      return;
    }
    const isNewVault = !(await this.app.hasVault());
    try {
      await this.app.unlock(passphrase);
      if (isNewVault) await this.app.store.save();
      this.redirect(res, "ok", "暗号化ストアを開きました。", "profile");
    } catch (err) {
      const message = err instanceof CatashiroAppError ? err.message : "ストアを開けませんでした。";
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
      const message = err instanceof CatashiroAppError ? err.message : "リカバリーキーで開けませんでした。";
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
    const formatError = validateProfileValue(key, value);
    if (formatError) {
      this.redirect(res, "error", formatError);
      return;
    }

    store.setProfileValue(key, label, value, matchTerms);
    await store.save();
    this.redirect(res, "ok", "個人情報を保存しました。", "profile");
  }

  private async saveAllProfile(form: URLSearchParams, res: ServerResponse): Promise<void> {
    const store = this.app.store;
    const deleteKeys = new Set(form.getAll("deleteKeys"));
    const customDeleteKeys = new Set(form.getAll("customDeleteKeys"));

    for (const key of KNOWN_PROFILE_KEYS) {
      if (deleteKeys.has(key)) continue;
      const formatError = validateProfileValue(key, formValue(form, `profile.${key}`));
      if (formatError) {
        this.redirect(res, "error", `${PROFILE_FIELD_LABELS[key]}: ${formatError}`, "profile", "edit");
        return;
      }
    }

    for (const key of KNOWN_PROFILE_KEYS) {
      if (deleteKeys.has(key)) {
        store.deleteProfileValue(key);
        continue;
      }
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
      if (customDeleteKeys.has(key)) {
        store.deleteProfileValue(key);
        continue;
      }
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
    const reveal: Reveal = { label: `${entry.label} [${entry.key}]`, value: entry.value };
    if (key === MOST_SENSITIVE_KEY) {
      reveal.warning = "セキュリティコードは最も重要な情報です。画面の外にメモしたり、他のサービスに貼り付けたりしないでください。";
    }
    this.sendHtml(res, 200, this.renderHome(undefined, reveal, { tab: "profile", profileMode: "view" }));
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
