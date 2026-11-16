# Contributing

The private RenrenCodex monorepo is authoritative. This repository receives a
generated, allowlisted Desktop snapshot; generated paths listed in
`desktop-shared-snapshot.json` must not be edited directly.

Before proposing a change, run:

```bash
bun install --frozen-lockfile
bun audit --audit-level high
bun run publication:check
bun run format:check
bun run lint
bun run typecheck
bun run test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Do not include credentials, private infrastructure details, customer data, or
third-party code without a compatible license. Open a pull request for review and
include a Developer Certificate of Origin sign-off in every commit (`git commit
-s`).
