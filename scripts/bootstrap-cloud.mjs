// Run once from the Issue worktree with local ADC. CI never runs this foundation bootstrap.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
const project = process.env.TF_VAR_project_id;
for (const key of [
  "TF_VAR_project_id",
  "TF_VAR_billing_account",
  "TF_VAR_github_repository_id",
  "TF_VAR_github_owner_id",
]) {
  if (!process.env[key]) throw new Error(`required-environment:${key}`);
}
if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error("invalid-project-id");
const directory = "state/cloud-bootstrap";
mkdirSync(directory, { recursive: true, mode: 0o700 });
const terraform = (...args) =>
  execFileSync("terraform", [`-chdir=${directory}`, ...args], { stdio: "inherit" });
const configPath = `${directory}/.terraform/terraform.tfstate`;
const remote = existsSync(configPath) && JSON.parse(readFileSync(configPath, "utf8")).backend?.type === "gcs";
writeFileSync(
  `${directory}/main.tf`,
  readFileSync("infra/bootstrap/main.tf", "utf8").replace(
    'backend "gcs" {}',
    remote ? 'backend "gcs" {}' : 'backend "local" {}',
  ),
);
writeFileSync(`${directory}/.terraform.lock.hcl`, readFileSync("infra/bootstrap/.terraform.lock.hcl"));
if (remote)
  terraform(
    "init",
    "-reconfigure",
    `-backend-config=bucket=${project}-bootstrap-tfstate`,
    "-backend-config=prefix=bootstrap",
  );
else terraform("init");
terraform("plan", "-out=bootstrap.tfplan");
terraform("apply", "bootstrap.tfplan");
if (!remote) {
  writeFileSync(`${directory}/main.tf`, readFileSync("infra/bootstrap/main.tf"));
  terraform(
    "init",
    "-migrate-state",
    "-force-copy",
    `-backend-config=bucket=${project}-bootstrap-tfstate`,
    "-backend-config=prefix=bootstrap",
  );
}
// Key material is generated in memory, sent on stdin, and never enters Terraform state, logs or GitHub.
for (const secret of ["tier3-ticket-key", "feedback-validator-key"]) {
  const versions = JSON.parse(
    execFileSync(
      "gcloud",
      [
        "secrets",
        "versions",
        "list",
        secret,
        "--project",
        project,
        "--filter=state:ENABLED",
        "--format=json",
      ],
      { encoding: "utf8" },
    ),
  );
  if (versions.length === 0)
    execFileSync("gcloud", ["secrets", "versions", "add", secret, "--project", project, "--data-file=-"], {
      input: randomBytes(32).toString("hex"),
      stdio: ["pipe", "inherit", "inherit"],
    });
}
console.log("Foundation ready; runtime keys exist in Secret Manager. Runtime deployment is separate.");
