# Security policy

Please do not open public issues for suspected vulnerabilities or include tokens,
private keys, customer data, terminal output, source code, or production URLs in a
report. Use GitHub's private vulnerability reporting entry under the repository's
Security tab. If that entry is unavailable, contact a maintainer privately before
sharing details.

Maintainers treat reports as confidential, acknowledge receipt, reproduce against
a supported release, coordinate a fix in this repository, and disclose only after
affected official builds are available.

Only the latest official stable Desktop release is supported. An official build
is an immutable `v<stable-semver>` GitHub Release produced by the protected
release workflow with its platform signatures, checksums, SBOM, and provenance
attestations intact. Source snapshots, CI artifacts, forks, ad-hoc signed macOS
packages, and unsigned builds are not official releases.
