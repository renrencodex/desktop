import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  assertNewerRelease,
  buildWindowsDesktopReleaseManifest,
  highestPublishedVersion,
  readPublishedVersion,
} from "./release-manifest";

const PUBLIC_MANIFEST_URL = "https://renrencodex.com/downloads/desktop/stable/latest.json";
const PUBLIC_HIGHEST_VERSION_URL = "https://renrencodex.com/downloads/desktop/stable/highest.json";
const repositoryRoot = resolve(import.meta.dir, "../../..");
const desktopRoot = resolve(import.meta.dir, "..");

export function resolveRepositoryPath(path: string): string {
  return resolve(repositoryRoot, path);
}

export function resolveReleaseOutputDirectory(
  version: string,
  outputOverride: string | null,
): string {
  return outputOverride
    ? resolveRepositoryPath(outputOverride)
    : resolveRepositoryPath(`target/desktop-release/${version}`);
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
  return readPublishedVersion(JSON.parse(await readFile(resolveRepositoryPath(source), "utf8")));
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

async function main(): Promise<void> {
  const notesFile = option("--notes-file");
  if (!notesFile) throw new Error("Usage: release:prepare --notes-file <path>");

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
  const current = highestPublishedVersion([latestVersion, highestVersion]);
  assertNewerRelease(version, current);

  const bundleDirectory = resolve(repositoryRoot, "target/release/bundle/msi");
  const packages = (await readdir(bundleDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".msi"))
    .map((entry) => resolve(bundleDirectory, entry.name));
  if (packages.length !== 1) {
    throw new Error("Expected exactly one MSI; clean target/release/bundle/msi and rebuild");
  }
  const sourceMsi = packages[0]!;
  const sourceSignature = `${sourceMsi}.sig`;
  const signature = (await readFile(sourceSignature, "utf8")).trim();
  const notes = await readFile(resolveRepositoryPath(notesFile), "utf8");
  const publishedAt = new Date().toISOString();
  const manifest = buildWindowsDesktopReleaseManifest({
    version,
    notes,
    publishedAt,
    signature,
  });

  const outputOverride = option("--output-dir");
  const outputDirectory = resolveReleaseOutputDirectory(version, outputOverride);
  await mkdir(outputDirectory, { recursive: true });
  const releaseName = `renrencodex-desktop-${version}-x64.msi`;
  const releaseMsi = resolve(outputDirectory, releaseName);
  const releaseSignature = `${releaseMsi}.sig`;
  await copyFile(sourceMsi, releaseMsi, constants.COPYFILE_EXCL);
  await copyFile(sourceSignature, releaseSignature, constants.COPYFILE_EXCL);
  const digest = await sha256(releaseMsi);
  await writeFile(
    resolve(outputDirectory, "highest.json"),
    `${JSON.stringify({ version }, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(
    resolve(outputDirectory, "latest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" },
  );
  await writeFile(resolve(outputDirectory, "SHA256SUMS"), `${digest}  ${releaseName}\n`, {
    flag: "wx",
  });

  console.log(`Prepared Desktop ${version} in ${outputDirectory}`);
  console.log(`${digest}  ${basename(releaseMsi)}`);
}

if (import.meta.main) {
  await main();
}
