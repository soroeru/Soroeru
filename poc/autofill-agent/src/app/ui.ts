// Local app UI (RFC-001 v3 §7, UI-001 / #17): an interactive CLI menu over
// `AutofillApp` + `AppRunner` for personal data management, site inventory /
// mandates, bulk-update selection, new registration (via the
// review-and-confirm gate, `CliGate`), and settings (AI provider, recovery
// key, encrypted export/import).
//
// Sensitive values (card / CVV / credentials / API key) are masked by
// default (`maskValue`); revealing them requires re-entering the master
// passphrase (`PocStore.verifyPassphrase`), per the Claude Review follow-up
// on #17. Destructive actions require an explicit confirmation.

import { createInterface } from "node:readline/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { staleFilledFields } from "../agent/records.js";
import { CliGate, maskValue } from "../agent/gate.js";
import {
  isSensitiveKey,
  KNOWN_PROFILE_KEYS,
  PROFILE_FIELD_LABELS,
  type ProfileKey,
  type SiteRecord,
} from "../types.js";
import { PocStore, type ProfileEntry } from "../store/store.js";
import { AutofillAppError, type AutofillApp } from "./app.js";
import type { AppRunner, AppRunnerHooks } from "./runner.js";

/** Prompt for a line of input, echoed normally. Returns the trimmed value. */
export async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/** Prompt for a yes/no confirmation (destructive actions). */
export async function confirm(prompt: string): Promise<boolean> {
  return (await ask(`${prompt} [y/N] `)).toLowerCase() === "y";
}

/**
 * Prompt for a line of input without echoing it to the terminal (master
 * passphrase, recovery key, API key, CVV, account password, ...). Falls back
 * to silently reading a line when stdin is not a TTY (e.g. piped input).
 */
export function askSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    const isTTY = stdin.isTTY === true;
    if (isTTY) stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = (): void => {
      stdin.removeListener("data", onData);
      if (isTTY) stdin.setRawMode?.(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          return;
        } else if (ch === "\u0003") {
          finish();
          process.exit(130);
        } else if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (isTTY) process.stdout.write("\b \b");
          }
        } else {
          value += ch;
          if (isTTY) process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

function asProvider(input: string): "anthropic" | "openai" | undefined {
  return input === "anthropic" || input === "openai" ? input : undefined;
}

/** I/O hooks for `AppUI`; injectable for tests, defaulting to real stdin/stdout. */
export interface UiIo {
  ask: (prompt: string) => Promise<string>;
  confirm: (prompt: string) => Promise<boolean>;
  askSecret: (prompt: string) => Promise<string>;
  log: (message: string) => void;
}

const defaultIo: UiIo = { ask, confirm, askSecret, log: (m) => console.log(m) };

/** Interactive CLI UI: the single entry point a UI-driving command needs. */
export class AppUI {
  constructor(
    private readonly app: AutofillApp,
    private readonly runner: AppRunner,
    private readonly io: UiIo = defaultIo,
  ) {}

  /** Run the main menu loop until the user exits (returns when the store is locked and re-unlock is declined). */
  async run(): Promise<void> {
    for (;;) {
      if (!this.app.isUnlocked) {
        if (!(await this.reunlock())) return;
      }
      this.app.touch();
      this.io.log("\n=== autofill ===");
      this.io.log("1) 個人情報  2) サイト一覧 / mandate  3) 一括更新  4) 新規登録  5) 設定  0) 終了");
      const choice = await this.io.ask("> ");
      try {
        switch (choice) {
          case "1":
            await this.profileMenu();
            break;
          case "2":
            await this.siteMenu();
            break;
          case "3":
            await this.bulkUpdateMenu();
            break;
          case "4":
            await this.registerMenu();
            break;
          case "5":
            await this.settingsMenu();
            break;
          case "0":
          case "":
          case "q":
            return;
          default:
            this.io.log("不明な選択です");
        }
      } catch (err) {
        if (err instanceof AutofillAppError) {
          this.io.log(`\n${err.message}`);
          continue;
        }
        throw err;
      }
    }
  }

  private async reunlock(): Promise<boolean> {
    this.io.log("\nアイドルタイムアウトによりロックされました。マスターパスフレーズを再入力してください（空欄で終了）。");
    const passphrase = await this.io.askSecret("マスターパスフレーズ: ");
    if (!passphrase) return false;
    try {
      await this.app.unlock(passphrase);
      return true;
    } catch (err) {
      this.io.log(err instanceof AutofillAppError ? err.message : String(err));
      return false;
    }
  }

  // --- 1) Personal data --------------------------------------------------

  private async profileMenu(): Promise<void> {
    for (;;) {
      const entries = [...this.app.store.profile.values()].sort((a, b) => a.key.localeCompare(b.key));
      this.io.log("\n--- 個人情報 ---");
      if (entries.length === 0) this.io.log("(項目はまだありません)");
      entries.forEach((e, i) => this.io.log(`${i + 1}. [${e.key}] ${e.label}: ${maskValue(e.key, e.value)}`));
      this.io.log("a) 追加  e) 編集  r) 表示（機密項目は要再認証）  d) 削除  0) 戻る");
      const choice = (await this.io.ask("> ")).toLowerCase();
      if (choice === "0" || choice === "") return;
      else if (choice === "a") await this.addProfileField(entries);
      else if (choice === "e") await this.editProfileField(entries);
      else if (choice === "r") await this.revealProfileField(entries);
      else if (choice === "d") await this.deleteProfileField(entries);
      else this.io.log("不明な選択です");
    }
  }

  private async enterValue(key: ProfileKey, label: string): Promise<string | undefined> {
    if (isSensitiveKey(key)) {
      this.io.log(`「${label}」は機密項目です。入力中は表示されません。`);
      const value = await this.io.askSecret(`${label}: `);
      return value || undefined;
    }
    const value = await this.io.ask(`${label}: `);
    return value || undefined;
  }

  private async addProfileField(entries: ProfileEntry[]): Promise<void> {
    const used = new Set(entries.map((e) => e.key));
    const available = KNOWN_PROFILE_KEYS.filter((k) => !used.has(k));
    this.io.log("\n追加する項目:");
    available.forEach((k, i) => this.io.log(`${i + 1}. ${PROFILE_FIELD_LABELS[k]} [${k}]`));
    this.io.log("c) カスタム項目");
    const choice = (await this.io.ask("番号、または c（空欄でキャンセル）: ")).toLowerCase();
    if (!choice) return;

    let key: ProfileKey;
    let label: string;
    let matchTerms: string[] | undefined;
    if (choice === "c") {
      const slug = await this.io.ask("カスタム項目のキー（custom.に続く識別子、英数字のみ）: ");
      if (!slug || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
        this.io.log("無効なキーです");
        return;
      }
      label = await this.io.ask("ラベル: ");
      if (!label) {
        this.io.log("ラベルは必須です");
        return;
      }
      key = `custom.${slug}`;
      const terms = await this.io.ask("マッチング用語（カンマ区切り、空欄でラベルを使用）: ");
      matchTerms = terms ? terms.split(",").map((t) => t.trim()).filter(Boolean) : [label];
    } else {
      const picked = available[Number(choice) - 1];
      if (!picked) {
        this.io.log("無効な選択です");
        return;
      }
      key = picked;
      label = PROFILE_FIELD_LABELS[picked];
    }

    const value = await this.enterValue(key, label);
    if (value === undefined) {
      this.io.log("キャンセルしました");
      return;
    }
    this.app.store.setProfileValue(key, label, value, matchTerms);
    await this.app.store.save();
    this.io.log("保存しました");
  }

  private async editProfileField(entries: ProfileEntry[]): Promise<void> {
    if (entries.length === 0) {
      this.io.log("項目がありません");
      return;
    }
    const entry = entries[Number(await this.io.ask("編集する項目の番号: ")) - 1];
    if (!entry) {
      this.io.log("無効な選択です");
      return;
    }
    const value = await this.enterValue(entry.key, entry.label);
    if (value === undefined) {
      this.io.log("キャンセルしました");
      return;
    }
    this.app.store.setProfileValue(entry.key, entry.label, value, entry.matchTerms);
    await this.app.store.save();
    this.io.log("更新しました");
  }

  private async revealProfileField(entries: ProfileEntry[]): Promise<void> {
    if (entries.length === 0) {
      this.io.log("項目がありません");
      return;
    }
    const entry = entries[Number(await this.io.ask("表示する項目の番号: ")) - 1];
    if (!entry) {
      this.io.log("無効な選択です");
      return;
    }
    if (isSensitiveKey(entry.key)) {
      const passphrase = await this.io.askSecret("機密項目です。マスターパスフレーズを再入力してください: ");
      if (!(await this.app.store.verifyPassphrase(passphrase))) {
        this.io.log("パスフレーズが一致しません。表示を中止しました。");
        return;
      }
    }
    this.io.log(`${entry.label} [${entry.key}] = ${entry.value}`);
  }

  private async deleteProfileField(entries: ProfileEntry[]): Promise<void> {
    if (entries.length === 0) {
      this.io.log("項目がありません");
      return;
    }
    const entry = entries[Number(await this.io.ask("削除する項目の番号: ")) - 1];
    if (!entry) {
      this.io.log("無効な選択です");
      return;
    }
    if (!(await this.io.confirm(`「${entry.label}」[${entry.key}] を削除しますか？`))) return;
    this.app.store.deleteProfileValue(entry.key);
    await this.app.store.save();
    this.io.log("削除しました");
  }

  // --- 2) Site inventory / mandates --------------------------------------

  private async siteMenu(): Promise<void> {
    for (;;) {
      const records = this.app.store.listSiteRecords();
      this.io.log("\n--- サイト一覧 ---");
      if (records.length === 0) this.io.log("(登録済みサイトはまだありません)");
      records.forEach((r, i) => {
        const stale = staleFilledFields(this.app.store, r);
        const flag = stale.length > 0 ? ` ⚠ 更新候補 ${stale.length}件` : "";
        const updated = r.lastUpdatedAt ? ` / 最終更新 ${new Date(r.lastUpdatedAt).toLocaleString("ja-JP")}` : "";
        this.io.log(`${i + 1}. ${r.serviceName} (${r.origin}) [${r.status}]${updated}${flag}`);
      });
      this.io.log("v) 詳細・mandateを表示  d) 削除  0) 戻る");
      const choice = (await this.io.ask("> ")).toLowerCase();
      if (choice === "0" || choice === "") return;
      else if (choice === "v") await this.viewSiteRecord(records);
      else if (choice === "d") await this.deleteSiteRecordMenu(records);
      else this.io.log("不明な選択です");
    }
  }

  private async viewSiteRecord(records: SiteRecord[]): Promise<void> {
    if (records.length === 0) {
      this.io.log("登録済みサイトはありません");
      return;
    }
    const record = records[Number(await this.io.ask("番号: ")) - 1];
    if (!record) {
      this.io.log("無効な選択です");
      return;
    }
    this.io.log(`\n${record.serviceName} (${record.origin})`);
    this.io.log(`status: ${record.status} / registeredAt: ${new Date(record.registeredAt).toLocaleString("ja-JP")}`);
    if (record.lastUpdatedAt) this.io.log(`lastUpdatedAt: ${new Date(record.lastUpdatedAt).toLocaleString("ja-JP")}`);
    this.io.log("filledFields:");
    for (const ff of record.filledFields) {
      const label = this.app.store.profile.get(ff.profileKey)?.label ?? ff.profileKey;
      this.io.log(`  - ${label} [${ff.profileKey}]${ff.transform ? ` (${ff.transform})` : ""} -> ${ff.fieldName}`);
    }
    const mandates = this.app.store.listMandates(record.origin);
    this.io.log(`mandates (${mandates.length}):`);
    for (const m of mandates) {
      const extra = [
        m.highRiskFlags.length > 0 ? `highRisk=${m.highRiskFlags.join(",")}` : undefined,
        m.paymentStopped ? "paymentStopped" : undefined,
        m.cardFilled ? "cardFilled" : undefined,
      ].filter(Boolean);
      this.io.log(`  - ${new Date(m.authorizedAt).toLocaleString("ja-JP")}: result=${m.result}${extra.length > 0 ? ` (${extra.join(", ")})` : ""}`);
    }
  }

  private async deleteSiteRecordMenu(records: SiteRecord[]): Promise<void> {
    if (records.length === 0) {
      this.io.log("登録済みサイトはありません");
      return;
    }
    const record = records[Number(await this.io.ask("削除する番号: ")) - 1];
    if (!record) {
      this.io.log("無効な選択です");
      return;
    }
    if (!(await this.io.confirm(`「${record.serviceName}」(${record.origin}) をサイト一覧から削除しますか？（実サイト側のアカウントは削除されません）`))) return;
    this.app.store.deleteSiteRecord(record.siteId);
    await this.app.store.save();
    this.io.log("削除しました");
  }

  // --- 3) Bulk update ------------------------------------------------------

  private async bulkUpdateMenu(): Promise<void> {
    const candidates = this.app.store
      .listSiteRecords()
      .map((record) => ({ record, stale: staleFilledFields(this.app.store, record) }))
      .filter((c) => c.stale.length > 0);
    if (candidates.length === 0) {
      this.io.log("更新が必要なサイトはありません");
      return;
    }
    this.io.log("\n--- 一括更新: 対象を選択 ---");
    candidates.forEach((c, i) => {
      const labels = c.stale.map((ff) => this.app.store.profile.get(ff.profileKey)?.label ?? ff.profileKey);
      this.io.log(`${i + 1}. ${c.record.serviceName} (${c.record.origin}) — ${labels.join(", ")}`);
    });
    const choice = (await this.io.ask("番号をカンマ区切りで選択（all=すべて、空欄でキャンセル）: ")).toLowerCase();
    if (!choice) return;
    const selected =
      choice === "all"
        ? candidates
        : choice
            .split(",")
            .map((s) => candidates[Number(s.trim()) - 1])
            .filter((c): c is (typeof candidates)[number] => c !== undefined);
    if (selected.length === 0) {
      this.io.log("選択がありません");
      return;
    }

    const browser = await this.app.launchBrowser("chromium");
    try {
      for (const { record } of selected) {
        this.io.log(`\n=== ${record.serviceName} (${record.origin}) ===`);
        const page = await browser.newPage();
        try {
          const result = await this.runner.update(page, record.origin, record.siteId, this.hooks());
          this.io.log(`status: ${result.status}${result.changedKeys.length > 0 ? ` (${result.changedKeys.join(", ")})` : ""}`);
          for (const note of result.notes) this.io.log(`note: ${note}`);
        } catch (err) {
          this.io.log(`error: ${String(err)}`);
        } finally {
          await page.close();
        }
      }
    } finally {
      await this.app.closeBrowser(browser);
    }
  }

  // --- 4) New registration -------------------------------------------------

  private async registerMenu(): Promise<void> {
    const url = await this.io.ask("登録するサイトのURL（空欄でキャンセル）: ");
    if (!url) return;
    const browser = await this.app.launchBrowser("chromium");
    try {
      const page = await browser.newPage();
      try {
        const result = await this.runner.register(page, url, this.hooks());
        this.io.log(`\nstatus: ${result.status}`);
        for (const note of result.notes) this.io.log(`note: ${note}`);
      } catch (err) {
        this.io.log(`error: ${String(err)}`);
      } finally {
        await page.close();
      }
    } finally {
      await this.app.closeBrowser(browser);
    }
  }

  /** Hooks shared by registration and bulk update: CLI gate, missing-data prompt, and wall hand-off / resume. */
  private hooks(): AppRunnerHooks {
    return {
      gate: new CliGate(),
      promptUser: async (label) => {
        const value = await this.io.ask(`未保存の項目「${label}」の値を入力してください（空欄でスキップ）: `);
        return value || undefined;
      },
      handoff: async (_wall, instruction) => {
        this.io.log(`\n⚠ ${instruction}`);
        await this.io.ask("対応が完了したら Enter キーを押してください: ");
        return "resolved";
      },
      log: (m) => this.io.log(m),
    };
  }

  // --- 5) Settings -----------------------------------------------------------

  private async settingsMenu(): Promise<void> {
    for (;;) {
      const store = this.app.store;
      const settings = store.getSettings();
      this.io.log("\n--- 設定 ---");
      this.io.log(`AIプロバイダ: ${settings?.provider ?? "(未設定)"}`);
      this.io.log(`モデル: ${settings?.model ?? "(未設定)"}`);
      this.io.log(`APIキー: ${settings?.apiKey ? "••••••••（設定済み）" : "(未設定)"}`);
      this.io.log(`リカバリーキー: ${store.hasRecoveryKey ? "設定済み" : "未設定"}`);
      this.io.log("\nプライバシー方針 (PRIV-001 / PRIV-002):");
      this.io.log("- 通信先は操作対象サイトと上記AIプロバイダのみ。テレメトリ・クラウド同期なし。");
      this.io.log("- AIへの送信内容はフォーム構造・規約テキストのみ。個人情報の実値は送信しない。");
      this.io.log("- AIリクエストはステートレス（プロンプトキャッシュ・保存スレッド・メモリ機能は未使用）。");
      this.io.log(
        "\np) AIプロバイダ設定を変更  k) APIキーを表示（要再認証）  g) リカバリーキーを生成  x) リカバリーキーを削除  e) 暗号化エクスポート  i) 暗号化インポート  0) 戻る",
      );
      const choice = (await this.io.ask("> ")).toLowerCase();
      if (choice === "0" || choice === "") return;
      else if (choice === "p") await this.editProviderSettings();
      else if (choice === "k") await this.revealApiKey();
      else if (choice === "g") await this.generateRecoveryKey();
      else if (choice === "x") await this.removeRecoveryKey();
      else if (choice === "e") await this.exportStore();
      else if (choice === "i") await this.importStore();
      else this.io.log("不明な選択です");
    }
  }

  private async editProviderSettings(): Promise<void> {
    const provider = asProvider(await this.io.ask("プロバイダ (anthropic / openai、空欄でキャンセル): "));
    if (!provider) return;
    const model = await this.io.ask("モデル名: ");
    if (!model) {
      this.io.log("モデル名は必須です");
      return;
    }
    const apiKey = await this.io.askSecret("APIキー（入力中は表示されません）: ");
    if (!apiKey) {
      this.io.log("APIキーは必須です");
      return;
    }
    this.app.store.setProviderSettings({ provider, model, apiKey });
    await this.app.store.save();
    this.io.log("保存しました");
  }

  private async revealApiKey(): Promise<void> {
    const settings = this.app.store.getSettings();
    if (!settings) {
      this.io.log("未設定です");
      return;
    }
    const passphrase = await this.io.askSecret("マスターパスフレーズを再入力してください: ");
    if (!(await this.app.store.verifyPassphrase(passphrase))) {
      this.io.log("パスフレーズが一致しません。表示を中止しました。");
      return;
    }
    this.io.log(`provider=${settings.provider} model=${settings.model} apiKey=${settings.apiKey}`);
  }

  private async generateRecoveryKey(): Promise<void> {
    if (this.app.store.hasRecoveryKey) {
      if (!(await this.io.confirm("既存のリカバリーキーを置き換えますか？（古いキーは無効になります）"))) return;
    }
    const recoveryKey = await this.app.store.setupRecoveryKey();
    this.io.log("\n=== リカバリーキー（この画面でのみ表示されます） ===");
    this.io.log(recoveryKey);
    this.io.log("安全な場所に書き留めてください。ログ・スクリーンショット・AIへの送信は絶対にしないでください。");
    await this.io.ask("書き留めたら Enter キーを押してください: ");
    await this.app.store.save();
    if (await this.io.confirm("正しく書き留めたか確認のため、リカバリーキーを入力して検証しますか？")) {
      const candidate = await this.io.askSecret("リカバリーキー: ");
      this.io.log((await this.app.store.verifyRecoveryKey(candidate)) ? "検証成功" : "検証失敗（一致しません）");
    }
  }

  private async removeRecoveryKey(): Promise<void> {
    if (!this.app.store.hasRecoveryKey) {
      this.io.log("リカバリーキーは設定されていません");
      return;
    }
    if (!(await this.io.confirm("リカバリーキーを削除しますか？（マスターパスフレーズを忘れた場合の復旧手段がなくなります）"))) return;
    this.app.store.removeRecoveryKey();
    await this.app.store.save();
    this.io.log("削除しました");
  }

  private async exportStore(): Promise<void> {
    const path = await this.io.ask("エクスポート先のファイルパス（空欄でキャンセル）: ");
    if (!path) return;
    const json = await this.app.store.exportEncrypted();
    await mkdir(dirname(path), { recursive: true });
    // persist: encrypted-export — same encrypted shape as the on-disk store (docs/security.md §4)
    await writeFile(path, json, "utf8");
    this.io.log(`暗号化データを書き出しました: ${path}`);
  }

  private async importStore(): Promise<void> {
    const source = await this.io.ask("インポートするファイルパス（空欄でキャンセル）: ");
    if (!source) return;
    let json: string;
    try {
      json = await readFile(source, "utf8");
    } catch (err) {
      this.io.log(`読み込みに失敗しました: ${String(err)}`);
      return;
    }
    const destination = (await this.io.ask(`復元先のファイルパス（空欄で ${source}.imported.json）: `)) || `${source}.imported.json`;
    if (destination === this.app.storeFilePath) {
      this.io.log("現在開いているストアへの上書きはできません。別のパスを指定してください。");
      return;
    }
    const passphrase = await this.io.askSecret("インポート先ストアのパスフレーズ: ");
    let overwrite = false;
    try {
      await readFile(destination, "utf8");
      overwrite = await this.io.confirm(`${destination} は既に存在します。上書きしますか？`);
      if (!overwrite) return;
    } catch {
      // destination does not exist yet; proceed without overwrite.
    }
    try {
      await PocStore.importEncrypted(destination, json, passphrase, { overwrite });
      this.io.log(`復元しました: ${destination}`);
    } catch (err) {
      this.io.log(`インポートに失敗しました: ${String(err)}`);
    }
  }
}
