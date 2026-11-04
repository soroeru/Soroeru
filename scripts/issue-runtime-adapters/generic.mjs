import {
  DEFAULT_WORKER_TIMEOUT_MS,
  REASON_CODES,
  buildWorkerPrompt,
  capabilityRecord,
  diagnostic,
  quoteSelectorArg,
  resolveExecutable,
  verifyModelCandidate,
  runProcess,
  spawnWorker,
  splitSelector,
} from "./shared.mjs";
import { fetchRuntimeCatalog } from "./catalog.mjs";
import {
  isModelAllowed,
  isModelDenied,
  isRetiredCommand,
} from "../ai-template/registry.mjs";

export function createAdapter(definition) {
  const agent = definition.name;
  return {
    agent,
    id: definition.id,
    evaluationOrder: definition.evaluationOrder,
    definition,
    /**
     * Probe the runtime's catalog models. Candidates come from `ctx.catalogEntry` (the persisted
     * model catalog) when supplied, otherwise from a fresh listing; both use the same source.
     */
    async discover(ctx = {}) {
      const run = ctx.runProcess ?? runProcess;
      const env = ctx.env ?? process.env;
      const records = [],
        diagnostics = [];
      const fail = (reason) => ({
        records,
        diagnostics: [
          ...diagnostics,
          diagnostic({ agent, status: "failed", reason }),
        ],
      });
      if (definition.retired) return fail(REASON_CODES.CLI_NOT_FOUND);
      const listing =
        ctx.catalogEntry ?? (await fetchRuntimeCatalog(definition, ctx));
      if (listing.status !== "ok")
        return fail(listing.reason ?? REASON_CODES.PROBE_FAILED);
      const cliPath = listing.cliPath;
      if (!cliPath || isRetiredCommand(cliPath, ctx.cwd))
        return fail(REASON_CODES.CLI_NOT_FOUND);
      // Alias-resolving runtimes pass the catalog value to `--model` and record the canonical
      // model the probe reports; `requestedModel` then carries the catalog value.
      const resolveModel = definition.models.resolveReportedModel === true;
      const filters =
        ctx.modelFilter === undefined
          ? null
          : [ctx.modelFilter].flat().filter(Boolean);
      let selected = 0;
      for (const { model, label } of listing.models) {
        if (filters && !filters.includes(model)) continue;
        selected++;
        // Never probe a model the repository policy excludes (deny wins over allow).
        if (isModelDenied(definition.id, model, ctx.cwd, label)) {
          diagnostics.push(
            diagnostic({
              agent,
              status: "failed",
              reason: REASON_CODES.MODEL_DENIED,
              model,
            }),
          );
          continue;
        }
        if (!isModelAllowed(definition.id, model, ctx.cwd)) {
          diagnostics.push(
            diagnostic({
              agent,
              status: "failed",
              reason: REASON_CODES.MODEL_NOT_ALLOWED,
              model,
            }),
          );
          continue;
        }
        const args = [
          quoteSelectorArg(cliPath),
          ...definition.selectorArgs.map((arg) =>
            quoteSelectorArg(arg === "{model}" ? model : arg),
          ),
        ];
        if (args.some((arg) => !arg)) {
          diagnostics.push(
            diagnostic({
              agent,
              status: "failed",
              reason: REASON_CODES.MODEL_NOT_SELECTABLE,
              model,
            }),
          );
          continue;
        }
        const selector = args.join(" ");
        const result = await verifyModelCandidate(
          { model, selector },
          { ...ctx, run, env, resolveModel, extraArgs: definition.probeArgs },
        );
        if (!result.ok) {
          diagnostics.push(
            diagnostic({
              agent,
              status: "failed",
              reason: result.reason,
              model,
            }),
          );
          continue;
        }
        const entry = resolveModel
          ? { model: result.reportedModel, requestedModel: model }
          : { model, requestedModel: label };
        if (
          resolveModel &&
          isModelDenied(definition.id, entry.model, ctx.cwd)
        ) {
          diagnostics.push(
            diagnostic({
              agent,
              status: "failed",
              reason: REASON_CODES.MODEL_DENIED,
              model,
            }),
          );
          continue;
        }
        if (records.some((record) => record.model === entry.model)) continue;
        for (const role of ["worker", "parent"])
          records.push(
            capabilityRecord({
              agent,
              ...entry,
              role,
              selector,
              timeoutMs: ctx.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS,
            }),
          );
        diagnostics.push(
          diagnostic({ agent, status: "ok", model: entry.model }),
        );
      }
      if (!selected) return fail(REASON_CODES.MODEL_NOT_SELECTABLE);
      return { records, diagnostics, cliPath };
    },
    async launch(ctx = {}, job) {
      if (definition.retired) throw new Error("runtime-retired");
      const env = ctx.env ?? process.env;
      const tokens = splitSelector(job.selector);
      if (isRetiredCommand(tokens[0], job.cwd ?? ctx.cwd))
        throw new Error("runtime-retired");
      const cliPath =
        (await (ctx.resolveExecutable ?? resolveExecutable)(tokens[0], {
          env,
          pathEnv: ctx.pathEnv,
        })) ?? tokens[0];
      if (isRetiredCommand(cliPath, job.cwd ?? ctx.cwd))
        throw new Error("runtime-retired");
      return (ctx.spawnWorker ?? spawnWorker)(
        cliPath,
        [...tokens.slice(1), ...definition.promptArgs, buildWorkerPrompt(job)],
        {
          timeoutMs: job.timeoutMs,
          env,
          cwd: job.cwd ?? ctx.cwd,
        },
      );
    },
  };
}
