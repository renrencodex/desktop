import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { desktopReleaseLayout } from "./prepare-desktop-release";

const repositoryRoot = resolve(import.meta.dir, "../../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createReleaseFixture(publishedVersion: string) {
  const root = await mkdtemp(join(tmpdir(), "renrencodex-desktop-release-test-"));
  temporaryDirectories.push(root);
  const inputDirectory = join(root, "input");
  const outputDirectory = join(root, "output");
  const layout = desktopReleaseLayout("0.2.14");
  await mkdir(inputDirectory, { recursive: true });
  await Promise.all(
    Object.values(layout).map((name) => writeFile(join(inputDirectory, name), `fixture:${name}\n`)),
  );
  const notesFile = join(root, "notes.txt");
  const publishedManifest = join(root, "latest.json");
  const publishedHighest = join(root, "highest.json");
  await Promise.all([
    writeFile(notesFile, "跨平台自动更新\n"),
    writeJson(publishedManifest, { version: publishedVersion }),
    writeJson(publishedHighest, { version: publishedVersion }),
  ]);
  return {
    inputDirectory,
    layout,
    notesFile,
    outputDirectory,
    publishedHighest,
    publishedManifest,
  };
}

async function runPrepare(fixture: Awaited<ReturnType<typeof createReleaseFixture>>) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      resolve(import.meta.dir, "prepare-desktop-release.ts"),
      "--input-dir",
      fixture.inputDirectory,
      "--notes-file",
      fixture.notesFile,
      "--output-dir",
      fixture.outputDirectory,
      "--published-manifest",
      fixture.publishedManifest,
      "--published-highest",
      fixture.publishedHighest,
    ],
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("cross-platform Desktop release layout", () => {
  test("uses immutable versioned updater and download names", () => {
    expect(desktopReleaseLayout("0.2.14")).toEqual({
      windowsMsi: "renrencodex-desktop-0.2.14-x64.msi",
      windowsSignature: "renrencodex-desktop-0.2.14-x64.msi.sig",
      macosDmg: "renrencodex-desktop-0.2.14-universal.dmg",
      macosUpdater: "renrencodex-desktop-0.2.14-universal.app.tar.gz",
      macosSignature: "renrencodex-desktop-0.2.14-universal.app.tar.gz.sig",
      linuxAppImage: "renrencodex-desktop-0.2.14-x86_64.AppImage",
      linuxSignature: "renrencodex-desktop-0.2.14-x86_64.AppImage.sig",
      linuxDeb: "renrencodex-desktop-0.2.14-x86_64.deb",
      linuxRpm: "renrencodex-desktop-0.2.14-x86_64.rpm",
    });
  });

  test("prepares a complete website tree and monotonic manifests", async () => {
    const fixture = await createReleaseFixture("0.2.13");
    const result = await runPrepare(fixture);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Prepared cross-platform Desktop 0.2.14");

    const downloads = join(fixture.outputDirectory, "downloads");
    const manifest = JSON.parse(
      await readFile(join(downloads, "desktop/stable/latest.json"), "utf8"),
    ) as {
      version: string;
      notes: string;
      pub_date: string;
      platforms: Record<string, { url: string; signature: string }>;
    };
    expect(manifest.version).toBe("0.2.14");
    expect(manifest.notes).toBe("跨平台自动更新");
    expect(Number.isFinite(Date.parse(manifest.pub_date))).toBe(true);
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      "darwin-aarch64",
      "darwin-x86_64",
      "linux-x86_64",
      "windows-x86_64",
    ]);
    expect(manifest.platforms["windows-x86_64"]?.signature).toBe(
      `fixture:${fixture.layout.windowsSignature}`,
    );
    expect(manifest.platforms["darwin-aarch64"]).toEqual(manifest.platforms["darwin-x86_64"]);
    expect(
      JSON.parse(await readFile(join(downloads, "desktop/stable/highest.json"), "utf8")),
    ).toEqual({ version: "0.2.14" });

    const fixedAndVersioned = [
      ["renrencodex-windows-x64.msi", `desktop/stable/windows-x86_64/${fixture.layout.windowsMsi}`],
      [
        "renrencodex-macos-universal.dmg",
        `desktop/stable/macos-universal/${fixture.layout.macosDmg}`,
      ],
      [
        "renrencodex-linux-x64.AppImage",
        `desktop/stable/linux-x86_64/${fixture.layout.linuxAppImage}`,
      ],
      ["renrencodex-linux-x64.deb", `desktop/stable/linux-x86_64/${fixture.layout.linuxDeb}`],
      ["renrencodex-linux-x64.rpm", `desktop/stable/linux-x86_64/${fixture.layout.linuxRpm}`],
    ] as const;
    for (const [fixed, versioned] of fixedAndVersioned) {
      expect(await Bun.file(join(downloads, fixed)).arrayBuffer()).toEqual(
        await Bun.file(join(downloads, versioned)).arrayBuffer(),
      );
    }
    const checksums = (await readFile(join(fixture.outputDirectory, "SHA256SUMS"), "utf8"))
      .trim()
      .split("\n");
    expect(checksums).toHaveLength(16);
  });

  test("rejects a version that is not newer than the published high-water mark", async () => {
    const fixture = await createReleaseFixture("0.2.14");
    const result = await runPrepare(fixture);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("must be newer than published 0.2.14");
  });
});
