import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

interface TerminalFontManifest {
  family: string;
  version: string;
  files: Array<{
    source: string;
    publicName: string;
    sha256: string;
  }>;
}

const assetDirectory = resolve(import.meta.dir, "../assets/terminal-font");

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function manifest(): Promise<TerminalFontManifest> {
  const parsed = JSON.parse(
    await readFile(resolve(assetDirectory, "manifest.json"), "utf8"),
  ) as TerminalFontManifest;
  if (!parsed.version || !Array.isArray(parsed.files) || parsed.files.length === 0)
    throw new Error("终端字体 manifest 无效");
  return parsed;
}

export async function copyTerminalFonts(targetDirectory: string): Promise<string[]> {
  const definition = await manifest();
  await mkdir(targetDirectory, { recursive: true });
  return Promise.all(
    definition.files.map(async (file) => {
      if (basename(file.source) !== file.source || basename(file.publicName) !== file.publicName)
        throw new Error(`终端字体文件名无效：${file.source}`);
      const source = resolve(assetDirectory, file.source);
      const content = await readFile(source);
      if (sha256(content) !== file.sha256) throw new Error(`终端字体摘要不匹配：${file.source}`);
      const target = resolve(targetDirectory, file.publicName);
      await copyFile(source, target);
      return target;
    }),
  );
}

if (import.meta.main) {
  const targetIndex = process.argv.indexOf("--target");
  const targetArgument = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined;
  if (!targetArgument) throw new Error("必须通过 --target 指定字体输出目录");
  const copied = await copyTerminalFonts(resolve(process.cwd(), targetArgument));
  console.log(`已准备 ${copied.length} 个终端字体资源`);
}
