import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
function tests(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? tests(join(folder, entry.name)) : /\.test\.(mjs|ts)$/.test(entry.name) ? [join(folder, entry.name)] : []);
}
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...tests("scripts"), ...tests("src/lib"), ...tests("desktop")], { stdio: "inherit" });
process.exit(result.status ?? 1);
