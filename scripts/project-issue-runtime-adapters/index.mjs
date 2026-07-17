import * as claude from "./claude.mjs";
import * as codex from "./codex.mjs";
import * as gemini from "./gemini.mjs";
import * as grok from "./grok.mjs";
import { REASON_CODES } from "./shared.mjs";

/** Fixed evaluation order: Codex → Claude → Grok → Gemini. */
export const RUNTIME_ADAPTERS = Object.freeze([codex, claude, grok, gemini]);

export function getAdapter(agentName) {
  const needle = String(agentName ?? "")
    .trim()
    .toLowerCase();
  return RUNTIME_ADAPTERS.find((adapter) => adapter.agent.toLowerCase() === needle) ?? null;
}

/**
 * Probe every adapter in fixed order. Partial failures never abort later adapters.
 * Returns capability records (success only) plus non-sensitive diagnostics.
 */
export async function discoverAllCapabilities(ctx = {}) {
  const capabilities = [];
  const diagnostics = [];
  for (const adapter of RUNTIME_ADAPTERS) {
    const adapterCtx = {
      ...ctx,
      ...(ctx.adapters?.[adapter.agent] ?? {}),
    };
    try {
      const result = await adapter.discover(adapterCtx);
      capabilities.push(...(result.records ?? []));
      diagnostics.push(...(result.diagnostics ?? []));
    } catch {
      diagnostics.push({
        agent: adapter.agent,
        status: "failed",
        reason: REASON_CODES.PROBE_FAILED,
      });
    }
  }
  return { capabilities, diagnostics };
}

export async function launchWithAdapter(agentName, job, ctx = {}) {
  const adapter = getAdapter(agentName);
  if (!adapter?.launch) throw new Error(`dispatch-adapter-unavailable:${agentName}`);
  return adapter.launch(ctx, job);
}

export { claude, codex, gemini, grok };
