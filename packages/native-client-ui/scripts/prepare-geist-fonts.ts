import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve(import.meta.dir, "../node_modules/geist/dist/fonts");
const target = resolve(import.meta.dir, "../public/fonts");
await mkdir(target, { recursive: true });
await Promise.all([
  copyFile(
    resolve(source, "geist-sans/Geist-Variable.woff2"),
    resolve(target, "Geist-Variable.woff2"),
  ),
  copyFile(
    resolve(source, "geist-mono/GeistMono-Variable.woff2"),
    resolve(target, "GeistMono-Variable.woff2"),
  ),
]);
