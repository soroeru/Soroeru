import type { FormSchema, AttributeKey } from "./cloud-contract.js";
export interface SchemaReadResult {
  values: { attributeKey: AttributeKey; itemId: string; value: string }[];
  unresolved: {
    attributeKey: AttributeKey;
    reason: "anchor-not-found" | "anchor-ambiguous" | "classifier-conflict";
  }[];
}

/** Reject malformed direct content results before values can reach the domain layer. */
export function validateSchemaReadResult(
  value: unknown,
  schema: FormSchema,
): asserts value is SchemaReadResult {
  const fail = (): never => {
    throw new Error("invalid-schema-read-result");
  };
  const object = (v: unknown, keys: string[]): Record<string, unknown> => {
    if (
      !v ||
      typeof v !== "object" ||
      Array.isArray(v) ||
      Object.keys(v).sort().join() !== keys.sort().join()
    )
      return fail();
    return v as Record<string, unknown>;
  };
  const o = object(value, ["values", "unresolved"]);
  if (
    !Array.isArray(o.values) ||
    !Array.isArray(o.unresolved) ||
    o.values.length + o.unresolved.length !== schema.fields.length
  )
    fail();
  const remaining = schema.fields.map((f) => f.attributeKey);
  const takeKey = (key: unknown): void => {
    const index = remaining.indexOf(key as AttributeKey);
    if (index < 0) fail();
    remaining.splice(index, 1);
  };
  const ids = new Set<string>();
  for (const value of o.values as unknown[]) {
    const item = object(value, ["attributeKey", "itemId", "value"]);
    takeKey(item.attributeKey);
    if (
      typeof item.itemId !== "string" ||
      !/^[fd]-[1-9][0-9]{0,5}$/.test(item.itemId) ||
      ids.has(item.itemId) ||
      typeof item.value !== "string"
    )
      fail();
    ids.add(item.itemId as string);
  }
  for (const value of o.unresolved as unknown[]) {
    const item = object(value, ["attributeKey", "reason"]);
    takeKey(item.attributeKey);
    if (!["anchor-not-found", "anchor-ambiguous", "classifier-conflict"].includes(String(item.reason)))
      fail();
  }
}
