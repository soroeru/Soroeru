import { Firestore } from "@google-cloud/firestore";
export interface DailyBudget {
  consume(): Promise<boolean>;
}
/** Transaction retries never exceed the shared daily cap. Errors fail closed in the HTTP layer. */
export class FirestoreDailyBudget implements DailyBudget {
  private readonly db = new Firestore();
  constructor(
    private readonly limit: number,
    private readonly now = () => new Date(),
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid-budget-limit");
  }
  async consume(): Promise<boolean> {
    const ref = this.db.collection("budgets").doc(this.now().toISOString().slice(0, 10));
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const count: unknown = snapshot.get("count") ?? 0;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
        throw new Error("invalid-budget-record");
      if (count >= this.limit) return false;
      transaction.set(ref, { count: count + 1 });
      return true;
    });
  }
}
