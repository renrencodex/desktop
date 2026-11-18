import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const desktopRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const binariesDir = join(desktopRoot, "src-tauri", "binaries");

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: repositoryRoot, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}`);
}

function hostTriple(): string {
  const result = Bun.spawnSync(["rustc", "-vV"], { cwd: repositoryRoot });
  if (result.exitCode !== 0) throw new Error("rustc -vV failed");
  const match = result.stdout.toString().match(/^host: (.+)$/m);
  if (!match?.[1]) throw new Error("rustc did not report a host target triple");
  return match[1].trim();
}

async function build(target: string): Promise<string> {
  await run([
    "cargo",
    "build",
    "--locked",
    "--release",
    "--package",
    "renrencodex-desktop",
    "--bin",
    "renrencodex-connect",
    "--target",
    target,
  ]);
  const extension = target.includes("windows") ? ".exe" : "";
  return join(repositoryRoot, "target", target, "release", `renrencodex-connect${extension}`);
}

await mkdir(binariesDir, { recursive: true });
const target = process.env.CONNECTOR_TARGET ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple();

if (target === "universal-apple-darwin") {
  const arm = await build("aarch64-apple-darwin");
  const intel = await build("x86_64-apple-darwin");
  const sidecarOutput = join(binariesDir, "renrencodex-connect-universal-apple-darwin");
  await run(["lipo", "-create", "-output", sidecarOutput, arm, intel]);
  await chmod(sidecarOutput, 0o755);

  // Tauri joins only the main Cargo binary for the synthetic Universal target.
  // Pre-populate the additional project binary where the macOS bundler expects it.
  const projectOutput = join(
    repositoryRoot,
    "target",
    "universal-apple-darwin",
    "release",
    "renrencodex-connect",
  );
  await mkdir(dirname(projectOutput), { recursive: true });
  await copyFile(sidecarOutput, projectOutput);
  await chmod(projectOutput, 0o755);
} else {
  const source = await build(target);
  const extension = target.includes("windows") ? ".exe" : "";
  await copyFile(source, join(binariesDir, `renrencodex-connect-${target}${extension}`));
}
