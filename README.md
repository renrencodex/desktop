# RenrenCodex Desktop

Cross-platform Desktop client for RenrenCodex, built with Tauri, React,
TypeScript, and Rust.

The source in this repository is available under the [Apache License 2.0](LICENSE).
RenrenCodex names and brand assets are governed separately by
[TRADEMARKS.md](TRADEMARKS.md).

## Upstream snapshot

The private RenrenCodex monorepo is authoritative. The public source under
`apps/desktop`, the client crates, and the explicitly allowlisted client packages
is generated from an exact upstream commit. See `desktop-shared-snapshot.json`.
Do not edit managed paths directly.

The current snapshot contains 341 managed files from production commit
`9f2dbe86c7ba25b67eb11eb5df6bd2cf06eddc5d`. Each file is recorded with a
SHA-256 digest in the snapshot manifest.

## Development

Requirements: Bun 1.4.2, the stable Rust toolchain, and the platform prerequisites
for Tauri 2.

```bash
bun install --frozen-lockfile
bun run sync:check
bun run typecheck
bun run test
bun run build
```

`bun run public:ready` is the fail-closed publication gate. It requires the new
schema v2 allowlisted snapshot, exact hashes, a repository-wide tracked-file and
reachable-history boundary/secret scan, dependency-lock validation, canonical
Apache-2.0 license text and metadata, and a fresh history containing only the
reviewed public tree. CI runs the same publication policy before installing
dependencies.
Gate jobs use a full, credential-free checkout and run before dependency install;
a shallow clone is not sufficient for publication review.

Run the native application with `bun run desktop:dev`. Package it with
`bun run desktop:build`. Production builds require `VITE_API_BASE_URL`,
`VITE_WEB_BASE_URL`, and `VITE_GATEWAY_WS_URL`; the application enforces the
trusted RenrenCodex HTTPS/WSS origin.

Web/Desktop source-parity suites remain in the private upstream because they
require `apps/web`. The schema v2 boundary scan and per-file hashes verify the
exported client tree.

Maintainers can refresh the snapshot from a local clone of the private monorepo:

```bash
bun run sync:upstream -- --source-repo /path/to/renrencodex \
  --ref <full-commit-sha> --channel production
```

The sync command accepts only a full commit reachable from the selected local
`main` or `production` branch, exports a path allowlist, rejects private or local
dependency edges and sensitive infrastructure markers before writing, and records
hashes for every managed file. The publication gate separately scans the complete
tracked public repository and every revision reachable from `HEAD`. It never
copies private Git history or a private remote URL.
