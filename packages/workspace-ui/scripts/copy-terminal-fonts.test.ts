import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { copyTerminalFonts } from "./copy-terminal-fonts";

test("copies the pinned terminal fonts after validating their digests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "terminal-font-assets-"));
  try {
    const copied = await copyTerminalFonts(directory);
    expect(copied.map((path) => basename(path)).sort()).toEqual([
      "IosevkaTerm-34.9.1-Bold.woff2",
      "IosevkaTerm-34.9.1-Regular.woff2",
    ]);
    for (const path of copied) {
      const digest = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
