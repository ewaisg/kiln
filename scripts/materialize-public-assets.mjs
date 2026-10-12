import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/@wllama/wllama/esm/wasm/wllama.wasm");
const dest = join(root, "public/wllama/wllama.wasm");

if (!existsSync(src)) {
  console.warn("[assets] @wllama/wllama wasm missing; local model loading will fail until dependencies are installed");
  process.exit(0);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log("[assets] copied wllama.wasm");
