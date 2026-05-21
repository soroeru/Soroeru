import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProfileFieldValidationError } from "../../src/shared/profile-validation.js";
import type { ProfileField } from "../../src/shared/types.js";
import { InMemoryProfileStorage } from "../../src/storage/profile-store.js";

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

  it("rejects credit-card-like values even when the label is generic", async () => {
    const storage = new InMemoryProfileStorage();

    await assert.rejects(
      storage.set({
        id: "unsafe-custom",
        kind: "custom",
        label: "Reference",
        value: "4111 1111 1111 1111",
        matchTerms: ["reference"],
        order: 1,
      }),
      ProfileFieldValidationError,
    );
  });
});
