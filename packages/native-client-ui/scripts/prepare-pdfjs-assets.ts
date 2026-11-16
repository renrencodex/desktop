import { cp, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve(import.meta.dir, "../node_modules/pdfjs-dist");
const { version } = JSON.parse(await readFile(resolve(source, "package.json"), "utf8")) as {
  version: string;
};
const target = resolve(import.meta.dir, `../public/pdfjs/${version}`);
await mkdir(target, { recursive: true });
await cp(resolve(source, "legacy/build/pdf.worker.min.mjs"), resolve(target, "pdf.worker.min.mjs"));
for (const folder of ["cmaps", "standard_fonts", "wasm"]) {
  await cp(resolve(source, folder), resolve(target, folder), { recursive: true });
}
