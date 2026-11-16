import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(import.meta.resolve("ghostty-web/ghostty-vt.wasm"));
const target = resolve(import.meta.dir, "../public/wasm/ghostty-vt-0.4.0.wasm");

await mkdir(dirname(target), { recursive: true });
await Bun.write(target, Bun.file(source));
