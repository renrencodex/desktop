import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");

interface ReleaseEnvironment {
  readonly RENRENCODEX_UPDATER_PUBLIC_KEY?: string;
  readonly TAURI_SIGNING_PRIVATE_KEY?: string;
}

export function readReleaseSigningEnvironment(environment: ReleaseEnvironment): {
  publicKey: string;
} {
  if (!environment.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
    throw new Error("TAURI_SIGNING_PRIVATE_KEY must be set for a signed Desktop release");
  }
  const publicKey = environment.RENRENCODEX_UPDATER_PUBLIC_KEY?.trim();
  if (!publicKey) {
    throw new Error("RENRENCODEX_UPDATER_PUBLIC_KEY must be set for a signed Desktop release");
  }
  return { publicKey };
}

export function createReleaseTauriConfig(publicKey: string): object {
  const normalizedPublicKey = publicKey.trim();
  if (!normalizedPublicKey) throw new Error("Desktop updater public key must not be empty");

  return {
    bundle: {
      createUpdaterArtifacts: true,
      externalBin: ["binaries/renrencodex-connect"],
    },
    plugins: {
      updater: {
        pubkey: normalizedPublicKey,
      },
    },
  };
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("The Windows MSI release must be built on Windows");
  }

  const { publicKey } = readReleaseSigningEnvironment(process.env);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "renrencodex-desktop-release-"));
  const configPath = join(temporaryDirectory, "tauri.release.conf.json");

  try {
    const connector = Bun.spawn([process.execPath, "run", "connector:prepare"], {
      cwd: desktopRoot,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const connectorExitCode = await connector.exited;
    if (connectorExitCode !== 0) {
      throw new Error(`Native connector build failed with exit code ${connectorExitCode}`);
    }
    await writeFile(
      configPath,
      `${JSON.stringify(createReleaseTauriConfig(publicKey), null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    const subprocess = Bun.spawn(
      [
        process.execPath,
        "run",
        "tauri",
        "build",
        "--ci",
        "--bundles",
        "msi",
        "--config",
        configPath,
      ],
      {
        cwd: desktopRoot,
        env: process.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    const exitCode = await subprocess.exited;
    if (exitCode !== 0)
      throw new Error(`Tauri Windows release build failed with exit code ${exitCode}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main();
}
