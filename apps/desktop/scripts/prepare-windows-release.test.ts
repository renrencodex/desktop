import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { resolveReleaseOutputDirectory, resolveRepositoryPath } from "./prepare-windows-release";

const repositoryRoot = resolve(import.meta.dir, "../../..");

describe("Desktop release paths", () => {
  test("resolves relative inputs from the repository root", () => {
    expect(resolveRepositoryPath("release-notes.txt")).toBe(
      resolve(repositoryRoot, "release-notes.txt"),
    );
    expect(resolveReleaseOutputDirectory("0.1.0", null)).toBe(
      resolve(repositoryRoot, "target/desktop-release/0.1.0"),
    );
    expect(resolveReleaseOutputDirectory("0.1.0", "staging/desktop")).toBe(
      resolve(repositoryRoot, "staging/desktop"),
    );
  });
});
