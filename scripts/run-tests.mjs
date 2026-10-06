import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const projectRoot = path.resolve(import.meta.dirname, "..");
const testSource = path.join(projectRoot, "server", "test");
const output = path.join(projectRoot, ".test-dist");
const entries = readdirSync(testSource)
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => path.join(testSource, name));

await build({ entryPoints: entries, bundle: true, packages: "external", platform: "node", format: "esm", target: "node20", outdir: output });
const tests = readdirSync(output)
  .filter((name) => name.endsWith(".test.js"))
  .map((name) => path.join(output, name));
const run = spawnSync(process.execPath, ["--test", ...tests], { cwd: projectRoot, stdio: "inherit" });
process.exit(run.status ?? 1);
