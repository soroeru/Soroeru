import { mkdir, readdir, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

async function findDmgs(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await findDmgs(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".dmg")) {
      paths.push(fullPath);
    }
  }
  return paths;
}

const dmgs = await findDmgs("out/make");
if (dmgs.length !== 1) {
  throw new Error(`Expected exactly one dmg under out/make, found ${dmgs.length}`);
}

await mkdir("release", { recursive: true });
const target = join("release", `Soroeru-${packageJson.version}.dmg`);
await rm(target, { force: true });
await copyFile(dmgs[0], target);
console.log(`created: ${target}`);
