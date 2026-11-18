import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

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
  const armSidecar = join(binariesDir, "renrencodex-connect-aarch64-apple-darwin");
  const intelSidecar = join(binariesDir, "renrencodex-connect-x86_64-apple-darwin");
  const sidecarOutput = join(binariesDir, "renrencodex-connect-universal-apple-darwin");
  await copyFile(arm, armSidecar);
  await copyFile(intel, intelSidecar);
  await chmod(armSidecar, 0o755);
  await chmod(intelSidecar, 0o755);
  await run(["lipo", "-create", "-output", sidecarOutput, arm, intel]);
  await chmod(sidecarOutput, 0o755);
} else {
  const source = await build(target);
  const extension = target.includes("windows") ? ".exe" : "";
  await copyFile(source, join(binariesDir, `renrencodex-connect-${target}${extension}`));
}
