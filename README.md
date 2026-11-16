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

## Official releases

`Desktop Packages` produces short-lived internal test artifacts. It does not
publish releases, and its Windows packages are not Authenticode signed while its
macOS package uses only an ad-hoc signature.

`Desktop Updater Packages` is the separate manual website-distribution workflow.
It accepts only the current `main` commit after CI for that exact SHA succeeds,
and reads the existing Tauri updater key only from the branch-restricted
`desktop-updater-release` Environment. The workflow builds and verifies a signed
Windows x64 MSI, macOS Universal updater archive and DMG, and Linux x64 AppImage,
DEB, and RPM. Its final artifact contains the complete `downloads/` tree,
cross-platform `latest.json`, monotonic `highest.json`, and SHA-256 checksums for
an operator to deploy atomically to `/var/www/html/downloads`; the workflow never
logs in to the origin server or changes the website itself.

These packages authenticate application updates with the Tauri key, but they are
not operating-system-trusted releases: Windows still reports an unknown
publisher, macOS is ad-hoc signed and not notarized, and the Linux packages are
not repository-signed. Keep `ENABLE_DESKTOP_UPDATER_BUILD=false` until the three
updater secrets, source snapshot, and exact-commit CI result have been checked.
The ordinary `Desktop Packages` artifacts do not embed the updater public key and
must not replace the website updater packages.

The separate `Desktop Release` workflow is fail closed and runs only when an
exact `v<stable-semver>` tag is pushed for the current `main` commit. The tag must
match `apps/desktop/package.json`, the snapshot must come from the upstream
`production` channel, and CI for that exact public commit must already have
succeeded. A release is published only after all of these checks pass:

- Windows x64 MSI has a valid CA-issued Authenticode signature, RFC 3161
  timestamp, and Tauri updater signature.
- macOS Universal app and DMG have a Developer ID Application signature, Apple
  notarization ticket, staple, Gatekeeper approval, and both `arm64` and
  `x86_64` slices.
- SPDX SBOM, SHA-256 checksums, and GitHub build-provenance attestations exist.
- Every asset is uploaded to a draft before the immutable release is published.

Linux packages remain CI artifacts until native package signing and the target
distribution matrix are complete. Publishing a GitHub Release does not update
the website's Desktop updater manifest or fixed download URL.

Signing material belongs only in the tag-restricted `desktop-release` GitHub
Environment. Configure these environment secrets:

- `WINDOWS_CERTIFICATE_PFX_BASE64` and `WINDOWS_CERTIFICATE_PASSWORD`
- `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and
  `RENRENCODEX_UPDATER_PUBLIC_KEY` (the public key is stored as a secret only to
  preserve its multiline value)
- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`, and `APPLE_API_PRIVATE_KEY_BASE64`

Configure `WINDOWS_EXPECTED_CERTIFICATE_THUMBPRINT`, `WINDOWS_TIMESTAMP_URL`,
and `APPLE_TEAM_ID` as environment variables. The pinned certificate thumbprint
must be the 40-character SHA-1 thumbprint used by the Windows certificate store;
the timestamp value must be the RFC 3161 service approved by the code signing
certificate provider. The current workflow imports an exportable PFX; providers
that require an HSM or cloud signing service need a reviewed Tauri `signCommand`
integration before activation.

Enable repository release immutability and restrict the Environment to `v*`
tags. Set `ENABLE_OFFICIAL_DESKTOP_RELEASE=true` as the final environment
variable only after every certificate, private key, password, and offline backup
has been verified. Then, after the current `main` CI succeeds, create and push the
matching version tag. Missing, expired, mismatched, unnotarized, or unstapled
signing material stops the workflow before publication.

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
