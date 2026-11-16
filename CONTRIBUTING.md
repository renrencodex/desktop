# Contributing

RenrenCodex Desktop is developed and reviewed in this repository. Bug fixes,
accessibility improvements, platform support, tests, documentation, and focused
feature changes are welcome.

The paths recorded in `desktop-shared-snapshot.json` are covered by an integrity
manifest. If a contribution changes one of those paths, call it out in the pull
request; maintainers will review and refresh the manifest as part of accepting
the change.

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
third-party code without a compatible license. Open a pull request for review,
describe the user-visible and protocol impact, and include a Developer Certificate
of Origin sign-off in every commit (`git commit -s`). Contributions are accepted
under the repository's MIT License.
