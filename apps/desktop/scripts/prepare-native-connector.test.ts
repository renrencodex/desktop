import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { connectorBuildCommand, connectorBuildOutput } from "./prepare-native-connector";

describe("native connector build staging", () => {
  test("isolates Cargo artifacts from the Tauri target directory", () => {
    const target = "x86_64-unknown-linux-gnu";
    const targetDir = join("repository", "target", "connector-sidecar-build");

    expect(connectorBuildCommand(target, targetDir)).toEqual([
      "cargo",
      "build",
      "--locked",
      "--release",
      "--package",
      "renrencodex-connect",
      "--target",
      target,
      "--target-dir",
      targetDir,
    ]);
    expect(connectorBuildOutput(target, targetDir)).toBe(
      join(targetDir, target, "release", "renrencodex-connect"),
    );
  });

  test("uses the Windows executable suffix", () => {
    const target = "x86_64-pc-windows-msvc";
    const targetDir = join("repository", "target", "connector-sidecar-build");

    expect(connectorBuildOutput(target, targetDir)).toBe(
      join(targetDir, target, "release", "renrencodex-connect.exe"),
    );
  });
});
