import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProfileFieldValidationError } from "../../src/shared/profile-validation.js";
import type { ProfileField } from "../../src/shared/types.js";
import { ChromeProfileStorage, InMemoryProfileStorage } from "../../src/storage/profile-store.js";

describe("InMemoryProfileStorage", () => {
  it("stores, lists, updates, deletes, and clears profile fields", async () => {
    const storage = new InMemoryProfileStorage();

    await storage.set({
      id: "email",
      kind: "email",
      label: "Email address",
      value: "taro.yamada@example.test",
      order: 20,
    });
    await storage.set({
      id: "name",
      kind: "fullName",
      label: "Full name",
      value: "Taro Yamada",
      order: 10,
    });

    assert.deepEqual(
      (await storage.list()).map((field) => field.id),
      ["name", "email"],
    );

    await storage.set({
      id: "email",
      kind: "email",
      label: "Email address",
      value: "updated@example.test",
      order: 20,
    });

    assert.equal((await storage.get("email"))?.value, "updated@example.test");

    await storage.delete("email");
    assert.equal(await storage.get("email"), undefined);

    await storage.clear();
    assert.deepEqual(await storage.list(), []);
  });

  it("stores custom fields with required match terms", async () => {
    const storage = new InMemoryProfileStorage();

    await storage.set({
      id: "industry",
      kind: "custom",
      label: "Industry",
      value: "Software",
      matchTerms: ["industry", "業種"],
      order: 30,
    });

    assert.deepEqual(await storage.get("industry"), {
      id: "industry",
      kind: "custom",
      label: "Industry",
      value: "Software",
      matchTerms: ["industry", "業種"],
      order: 30,
    });
  });

  it("rejects unsupported password and credit card categories at runtime", async () => {
    const storage = new InMemoryProfileStorage();

    await assert.rejects(
      storage.set({
        id: "password",
        kind: "password",
        label: "Password",
        value: "secret",
        order: 1,
      } as unknown as ProfileField),
      ProfileFieldValidationError,
    );

    await assert.rejects(
      storage.set({
        id: "credit-card",
        kind: "creditCard",
        label: "Credit card",
        value: "4111111111111111",
        order: 2,
      } as unknown as ProfileField),
      ProfileFieldValidationError,
    );
  });

  it("rejects credit-card-like custom fields", async () => {
    const storage = new InMemoryProfileStorage();

    await assert.rejects(
      storage.set({
        id: "card-number",
        kind: "custom",
        label: "Card number",
        value: "4111111111111111",
        matchTerms: ["credit card"],
        order: 1,
      }),
      ProfileFieldValidationError,
    );
  });

  it("allows generic long numeric references when the field is not credit-card-like", async () => {
    const storage = new InMemoryProfileStorage();

    await storage.set({
      id: "generic-reference",
      kind: "custom",
      label: "Reference",
      value: "4111 1111 1111 1111",
      matchTerms: ["reference"],
      order: 1,
    });

    assert.equal((await storage.get("generic-reference"))?.value, "4111 1111 1111 1111");
  });

  it("allows non-card expiration fields", async () => {
    const storage = new InMemoryProfileStorage();

    await storage.set({
      id: "contract-expiration",
      kind: "custom",
      label: "Contract expiration date",
      value: "2030-12-31",
      matchTerms: ["contract expiration"],
      order: 1,
    });

    assert.equal((await storage.get("contract-expiration"))?.value, "2030-12-31");
  });

  it("rejects card expiration fields", async () => {
    const storage = new InMemoryProfileStorage();

    await assert.rejects(
      storage.set({
        id: "card-expiration",
        kind: "custom",
        label: "Card expiration date",
        value: "12/30",
        matchTerms: ["card expiration"],
        order: 1,
      }),
      ProfileFieldValidationError,
    );
  });

  it("rejects sensitive labels that use underscores", async () => {
    const storage = new InMemoryProfileStorage();

    await assert.rejects(
      storage.set({
        id: "auth-otp",
        kind: "custom",
        label: "auth_otp",
        value: "123456",
        matchTerms: ["auth_otp"],
        order: 1,
      }),
      ProfileFieldValidationError,
    );

    await assert.rejects(
      storage.set({
        id: "card-number",
        kind: "custom",
        label: "card_number",
        value: "4111 1111 1111 1111",
        matchTerms: ["card_number"],
        order: 1,
      }),
      ProfileFieldValidationError,
    );
  });
});

describe("ChromeProfileStorage", () => {
  it("serializes concurrent set operations so fields are not lost", async () => {
    const storage = new ChromeProfileStorage(new FakeChromeStorageArea());

    await Promise.all([
      storage.set({
        id: "name",
        kind: "fullName",
        label: "Full name",
        value: "Taro Yamada",
        order: 10,
      }),
      storage.set({
        id: "email",
        kind: "email",
        label: "Email address",
        value: "taro.yamada@example.test",
        order: 20,
      }),
      storage.set({
        id: "company",
        kind: "companyName",
        label: "Company name",
        value: "Example Works Ltd.",
        order: 30,
      }),
    ]);

    assert.deepEqual(
      (await storage.list()).map((field) => field.id),
      ["name", "email", "company"],
    );
  });

  it("gets and deletes stored profile fields", async () => {
    const storage = new ChromeProfileStorage(new FakeChromeStorageArea());

    await storage.set({
      id: "email",
      kind: "email",
      label: "Email address",
      value: "taro.yamada@example.test",
      order: 10,
    });

    assert.equal((await storage.get("email"))?.value, "taro.yamada@example.test");

    await storage.delete("email");
    assert.equal(await storage.get("email"), undefined);
    assert.deepEqual(await storage.list(), []);
  });

  it("clears fields by removing the profile fields key", async () => {
    const storageArea = new FakeChromeStorageArea();
    const storage = new ChromeProfileStorage(storageArea);

    await storage.set({
      id: "email",
      kind: "email",
      label: "Email address",
      value: "taro.yamada@example.test",
      order: 10,
    });

    await storage.clear();

    assert.deepEqual(await storage.list(), []);
    assert.equal(storageArea.removeCallCount, 1);
    assert.deepEqual(storageArea.removedKeys, ["profileFields"]);
  });

  it("ignores invalid stored rows without hiding valid profile fields", async () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    const storageArea = new FakeChromeStorageArea({
      profileFields: [
        {
          id: "email",
          kind: "email",
          label: "Email address",
          value: "taro.yamada@example.test",
          order: 10,
        },
        {
          id: "legacy-password",
          kind: "password",
          label: "Password",
          value: "secret",
          order: 20,
        },
      ],
    });
    const storage = new ChromeProfileStorage(storageArea);

    try {
      assert.deepEqual(await storage.list(), [
        {
          id: "email",
          kind: "email",
          label: "Email address",
          value: "taro.yamada@example.test",
          order: 10,
        },
      ]);
      assert.equal(warnings.length, 1);
    } finally {
      console.warn = originalWarn;
    }
  });
});

class FakeChromeStorageArea implements ChromeStorageArea {
  removeCallCount = 0;
  removedKeys: string[] = [];

  constructor(private readonly values: Record<string, unknown> = {}) {}

  get(
    keys: string | string[] | Record<string, unknown> | null,
    callback: (items: Record<string, unknown>) => void,
  ): void {
    setTimeout(() => {
      if (typeof keys === "string") {
        callback({ [keys]: this.values[keys] });
        return;
      }

      if (Array.isArray(keys)) {
        callback(Object.fromEntries(keys.map((key) => [key, this.values[key]])));
        return;
      }

      callback({ ...this.values });
    }, 0);
  }

  set(items: Record<string, unknown>, callback?: () => void): void {
    setTimeout(() => {
      Object.assign(this.values, structuredClone(items));
      callback?.();
    }, 0);
  }

  remove(keys: string | string[], callback?: () => void): void {
    setTimeout(() => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        this.removedKeys.push(key);
        delete this.values[key];
      }
      this.removeCallCount += 1;
      callback?.();
    }, 0);
  }

  clear(callback?: () => void): void {
    setTimeout(() => {
      for (const key of Object.keys(this.values)) {
        delete this.values[key];
      }
      callback?.();
    }, 0);
  }
}
