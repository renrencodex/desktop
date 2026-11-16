import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import {
  assertNewerRelease,
  buildDesktopReleaseManifest,
  highestPublishedVersion,
  readPublishedVersion,
} from "./release-manifest";

const PUBLIC_MANIFEST_URL = "https://renrencodex.com/downloads/desktop/stable/latest.json";
const PUBLIC_HIGHEST_VERSION_URL = "https://renrencodex.com/downloads/desktop/stable/highest.json";
const repositoryRoot = resolve(import.meta.dir, "../../..");
const desktopRoot = resolve(import.meta.dir, "..");

interface ReleaseLayout {
  readonly windowsMsi: string;
  readonly windowsSignature: string;
  readonly macosDmg: string;
  readonly macosUpdater: string;
  readonly macosSignature: string;
  readonly linuxAppImage: string;
  readonly linuxSignature: string;
  readonly linuxDeb: string;
  readonly linuxRpm: string;
}

export function desktopReleaseLayout(version: string): ReleaseLayout {
  return {
    windowsMsi: `renrencodex-desktop-${version}-x64.msi`,
    windowsSignature: `renrencodex-desktop-${version}-x64.msi.sig`,
    macosDmg: `renrencodex-desktop-${version}-universal.dmg`,
    macosUpdater: `renrencodex-desktop-${version}-universal.app.tar.gz`,
    macosSignature: `renrencodex-desktop-${version}-universal.app.tar.gz.sig`,
    linuxAppImage: `renrencodex-desktop-${version}-x86_64.AppImage`,
    linuxSignature: `renrencodex-desktop-${version}-x86_64.AppImage.sig`,
    linuxDeb: `renrencodex-desktop-${version}-x86_64.deb`,
    linuxRpm: `renrencodex-desktop-${version}-x86_64.rpm`,
  };
}

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function publishedVersion(source: string): Promise<string | null> {
  if (/^https:\/\//.test(source)) {
    const response = await fetch(source, { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Cannot read published manifest: HTTP ${response.status}`);
    return readPublishedVersion(await response.json());
  }
  return readPublishedVersion(JSON.parse(await readFile(resolve(repositoryRoot, source), "utf8")));
}

async function digest(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

async function copyExclusive(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target, constants.COPYFILE_EXCL);
}

async function main(): Promise<void> {
  const inputOption = option("--input-dir");
  const notesOption = option("--notes-file");
  if (!inputOption || !notesOption) {
    throw new Error(
      "Usage: prepare-desktop-release --input-dir <path> --notes-file <path> [--output-dir <path>]",
    );
  }

  const packageJson = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string") {
    throw new Error("apps/desktop/package.json has no version");
  }
  const version = packageJson.version;
  const manifestOverride = option("--published-manifest");
  const highestOverride = option("--published-highest");
  if ((manifestOverride === null) !== (highestOverride === null)) {
    throw new Error("--published-manifest and --published-highest must be provided together");
  }
  const [latestVersion, highestVersion] = await Promise.all([
    publishedVersion(manifestOverride ?? PUBLIC_MANIFEST_URL),
    publishedVersion(highestOverride ?? PUBLIC_HIGHEST_VERSION_URL),
  ]);
  assertNewerRelease(version, highestPublishedVersion([latestVersion, highestVersion]));

  const inputDirectory = resolve(repositoryRoot, inputOption);
  const outputDirectory = resolve(
    repositoryRoot,
    option("--output-dir") ?? `target/desktop-release/${version}`,
  );
  const downloadsRoot = resolve(outputDirectory, "downloads");
  const layout = desktopReleaseLayout(version);
  const source = (name: string) => resolve(inputDirectory, name);
  const signatures = {
    windowsX86_64: (await readFile(source(layout.windowsSignature), "utf8")).trim(),
    macosUniversal: (await readFile(source(layout.macosSignature), "utf8")).trim(),
    linuxX86_64: (await readFile(source(layout.linuxSignature), "utf8")).trim(),
  };
  const notes = await readFile(resolve(repositoryRoot, notesOption), "utf8");
  const publishedAt = new Date().toISOString();
  const manifest = buildDesktopReleaseManifest({ version, notes, publishedAt, signatures });

  const versionedTargets = new Map<string, string>([
    [layout.windowsMsi, `desktop/stable/windows-x86_64/${layout.windowsMsi}`],
    [layout.windowsSignature, `desktop/stable/windows-x86_64/${layout.windowsSignature}`],
    [layout.macosDmg, `desktop/stable/macos-universal/${layout.macosDmg}`],
    [layout.macosUpdater, `desktop/stable/macos-universal/${layout.macosUpdater}`],
    [layout.macosSignature, `desktop/stable/macos-universal/${layout.macosSignature}`],
    [layout.linuxAppImage, `desktop/stable/linux-x86_64/${layout.linuxAppImage}`],
    [layout.linuxSignature, `desktop/stable/linux-x86_64/${layout.linuxSignature}`],
    [layout.linuxDeb, `desktop/stable/linux-x86_64/${layout.linuxDeb}`],
    [layout.linuxRpm, `desktop/stable/linux-x86_64/${layout.linuxRpm}`],
  ]);
  for (const [inputName, targetName] of versionedTargets) {
    await copyExclusive(source(inputName), resolve(downloadsRoot, targetName));
  }

  const fixedTargets = new Map<string, string>([
    [layout.windowsMsi, "renrencodex-windows-x64.msi"],
    [layout.macosDmg, "renrencodex-macos-universal.dmg"],
    [layout.linuxAppImage, "renrencodex-linux-x64.AppImage"],
    [layout.linuxDeb, "renrencodex-linux-x64.deb"],
    [layout.linuxRpm, "renrencodex-linux-x64.rpm"],
  ]);
  for (const [inputName, targetName] of fixedTargets) {
    await copyExclusive(source(inputName), resolve(downloadsRoot, targetName));
  }

  await mkdir(resolve(downloadsRoot, "desktop/stable"), { recursive: true });
  await writeFile(
    resolve(downloadsRoot, "desktop/stable/highest.json"),
    `${JSON.stringify({ version }, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(
    resolve(downloadsRoot, "desktop/stable/latest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );

  const checksumTargets = [
    ...versionedTargets.values(),
    ...fixedTargets.values(),
    "desktop/stable/highest.json",
    "desktop/stable/latest.json",
  ];
  const checksums: string[] = [];
  for (const targetName of checksumTargets) {
    const target = resolve(downloadsRoot, targetName);
    checksums.push(`${await digest(target)}  ${relative(downloadsRoot, target)}`);
  }
  await writeFile(resolve(outputDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`, {
    flag: "wx",
  });

  console.log(`Prepared cross-platform Desktop ${version} in ${outputDirectory}`);
}

if (import.meta.main) await main();
