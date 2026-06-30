// Condition-based waiting for unit tests.
//
// Tests that guess at timing with bare `setTimeout`/`sleep` are flaky: they
// pass locally but race in CI. `waitFor` polls an observable condition until it
// becomes truthy (or times out), so a test waits for the *state it cares about*
// rather than an arbitrary delay. See the `writing-good-tests` skill.

/**
 * Poll `condition` until it returns a truthy value, then return that value.
 * Throws with `description` if the condition stays falsy past `timeoutMs`.
 *
 * The condition may be sync or async; falsy results (`undefined`/`null`/`false`)
 * mean "not ready yet", so a state-narrowing predicate can return the value it
 * found and the caller gets it back already typed. Because falsy is the
 * "not ready" sentinel, the success value must never itself be falsy
 * (don't resolve on `0`, `""`, or `false`).
 *
 * `description` may be a function so callers can fold the last-observed value
 * into the timeout message; it is evaluated only when the timeout fires.
 */
export async function waitFor<T>(
  condition: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  description: string | (() => string),
  { timeoutMs = 5000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await condition();
    if (result) return result;
    if (Date.now() > deadline) {
      const what = typeof description === "function" ? description() : description;
      throw new Error(`Timeout waiting for ${what} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
