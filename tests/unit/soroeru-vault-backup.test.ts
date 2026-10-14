import assert from "node:assert/strict";
import { test } from "node:test";
import { saveVaultBackup, type BackupPicker } from "../../extension/vault-backup.js";

test("backup selects the destination before serialization and succeeds only after close", async () => {
  const events: string[] = [];
  let saved = "";
  const result = await saveVaultBackup(
    {
      showSaveFilePicker: async () => {
        events.push("picker");
        return {
          createWritable: async () => ({
            write: async (blob) => {
              saved = await blob.text();
              events.push("write");
            },
            close: async () => {
              events.push("close");
            },
            abort: async () => {},
          }),
        };
      },
    },
    async () => {
      events.push("serialize");
      return '{"vaultVersion":2,"records":[]}';
    },
  );
  assert.equal(result.outcome, "saved");
  assert.deepEqual(events, ["picker", "serialize", "write", "close"]);
  assert.equal(saved, '{"vaultVersion":2,"records":[]}');
});

test("picker cancel and file close failure never report a completed backup", async () => {
  await assert.rejects(() =>
    saveVaultBackup(
      {
        showSaveFilePicker: async () => {
          throw new DOMException("fake cancellation", "AbortError");
        },
      },
      async () => assert.fail("serialize after cancel"),
    ),
  );
  let aborted = false;
  const picker: BackupPicker = {
    showSaveFilePicker: async () => ({
      createWritable: async () => ({
        write: async () => {},
        close: async () => {
          throw new Error("fake disk full");
        },
        abort: async () => {
          aborted = true;
        },
      }),
    }),
  };
  await assert.rejects(() => saveVaultBackup(picker, async () => "encrypted fake export"), /disk full/);
  assert.equal(aborted, true);
});

test("unsupported picker returns ciphertext for a later download gesture", async () => {
  const result = await saveVaultBackup({}, async () => "encrypted fake export");
  assert.equal(result.outcome, "download");
  if (result.outcome !== "download") return;
  assert.equal(await result.blob.text(), "encrypted fake export");
  assert.match(result.name, /^soroeru-vault-\d{4}-\d{2}-\d{2}\.json$/);
});
