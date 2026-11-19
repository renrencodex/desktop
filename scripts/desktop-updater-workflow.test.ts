import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("isolates the standalone Linux connector from Tauri build artifacts", async () => {
  const workflow = await readFile(
    resolve(import.meta.dir, "../.github/workflows/desktop-updater-packages.yml"),
    "utf8",
  );

  expect(workflow).toContain('standalone_connector_target_dir="target/standalone-connector-build"');
  expect(workflow).toContain('--target-dir "$standalone_connector_target_dir"');
  expect(workflow).toContain(
    'connector="$standalone_connector_target_dir/x86_64-unknown-linux-musl/release/renrencodex-connect"',
  );
});
