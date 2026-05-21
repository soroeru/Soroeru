import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const extensionDir = path.join(root, "dist", "extension");
const compiledSrcDir = path.join(root, "dist", "compiled", "src");

await rm(extensionDir, { force: true, recursive: true });
await mkdir(extensionDir, { recursive: true });

await cp(compiledSrcDir, extensionDir, { recursive: true });
await cp(path.join(root, "src", "options", "options.html"), path.join(extensionDir, "options", "options.html"));
await cp(path.join(root, "src", "options", "options.css"), path.join(extensionDir, "options", "options.css"));

const manifest = await readFile(path.join(root, "src", "manifest.json"), "utf8");
await writeFile(path.join(extensionDir, "manifest.json"), manifest);
