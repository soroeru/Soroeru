import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import assert from "node:assert/strict";
const service = process.env.SOROERU_SERVICE;
assert.ok(service === "api" || service === "pii-fallback");
const child = spawn(process.execPath, ["dist/cloud/src/main.js"], { cwd: "/app/cloud", stdio: "inherit" });
const exited = new Promise((resolve) => child.once("exit", resolve));
let exit = false;
child.once("exit", () => {
  exit = true;
});
try {
  const deadline = Date.now() + 30000;
  let ready = false;
  while (!ready && !exit && Date.now() < deadline) {
    try {
      const isApi = service === "api";
      const response = await fetch(
        `http://127.0.0.1:8080/v1/${isApi ? "schemas/resolve" : "agent/read-with-consent"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isApi
              ? { site: "example.com", pageFingerprint: "invalid", clientVersion: "0.1.0" }
              : {
                  consentId: "11111111-1111-4111-8111-111111111111",
                  site: "example.com",
                  requestedKeys: ["email"],
                  items: [{ id: "d-1", text: "fake@example.com" }],
                  ticket: "abc.def",
                },
          ),
          signal: AbortSignal.timeout(1000),
        },
      );
      assert.equal(response.status, isApi ? 400 : 403);
      ready = true;
    } catch {
      if (!exit) await setTimeout(100);
    }
  }
  assert.ok(ready, "container-startup-smoke-failed");
  console.log(`PASS: ${service} production image starts and serves its isolated endpoint.`);
} finally {
  child.kill("SIGTERM");
  await Promise.race([exited, setTimeout(5000).then(() => child.kill("SIGKILL"))]);
}
