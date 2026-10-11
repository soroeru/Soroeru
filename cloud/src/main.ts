import { FirestoreSchemaRegistry } from "./schema-registry.js";
import { createCloudServer, type ServiceKind } from "./server.js";
import { FirestoreDailyBudget } from "./budget.js";
import { TicketAuthority } from "./tickets.js";

const service = process.env.SOROERU_SERVICE;
if (service !== "api" && service !== "pii-fallback") throw new Error("invalid-service-kind");
const key = process.env.TIER3_TICKET_KEY ?? "";
const limit = Number(process.env.GEMINI_DAILY_LIMIT ?? "100");
const port = Number(process.env.PORT ?? "8080");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid-port");
const server = createCloudServer({
  service: service as ServiceKind,
  ...(service === "api" ? { schemas: new FirestoreSchemaRegistry() } : {}),
  cloudRunProxy: Boolean(process.env.K_SERVICE),
  // The fallback never initializes a Firestore client.
  budget: service === "api" ? new FirestoreDailyBudget(limit) : { consume: async () => false },
  tickets: new TicketAuthority(key),
  log: (entry) => process.stdout.write(JSON.stringify(entry) + "\n"),
});
server.listen(port, "0.0.0.0");
process.on("SIGTERM", () => server.close());
