import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  validateCiRepositoryVisibility,
  validateManifestMetadata,
  validatePublicBoundary,
  validatePublicRepositoryHistory,
  validatePublicRepository,
  validatePublicationDocuments,
  validatePublicationMetadata,
  type TreeEntry,
} from "./sync-from-upstream";

function git(repository: string, ...args: string[]) {
  execFileSync("git", args, { cwd: repository, stdio: "ignore" });
}

function historyRepository(commits: ReadonlyArray<Readonly<Record<string, string | null>>>) {
  const repository = mkdtempSync(join(tmpdir(), "desktop-public-history-"));
  git(repository, "init", "-q");
  git(repository, "config", "user.name", "Publication Test");
  git(repository, "config", "user.email", "publication-test@example.invalid");
  commits.forEach((changes, index) => {
    for (const [path, value] of Object.entries(changes)) {
      const target = join(repository, path);
      if (value === null) unlinkSync(target);
      else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, value);
      }
    }
    git(repository, "add", "-A");
    git(repository, "commit", "-qm", `history fixture ${index + 1}`);
  });
  return repository;
}

const publicRoots = [
  "apps/desktop",
  "apps/renrencodex-connect",
  "crates/client-native",
  "crates/client-protocol",
  "packages/api-client",
  "packages/client-contracts",
  "packages/client-core",
  "packages/native-client-ui",
  "packages/platform-api",
  "packages/workspace-ui",
] as const;

function entry(path: string, content = "export {};\n"): TreeEntry {
  return {
    mode: "100644",
    object: "test-object",
    path,
    content: Buffer.from(content),
  };
}

function packageEntry(root: string, name: string, dependencies?: Record<string, string>) {
  return entry(
    `${root}/package.json`,
    `${JSON.stringify({ name, private: true, type: "module", dependencies }, null, 2)}\n`,
  );
}

function validEntries(): TreeEntry[] {
  return [
    packageEntry("apps/desktop", "@cloud-machine/desktop", {
      "@cloud-machine/client-contracts": "workspace:*",
    }),
    entry(
      "apps/desktop/src/main.ts",
      'import "@cloud-machine/client-contracts";\nimport "./local";\n',
    ),
    entry("apps/desktop/src/local.ts"),
    entry(
      "apps/renrencodex-connect/Cargo.toml",
      '[package]\nname = "renrencodex-connect"\nversion.workspace = true\n',
    ),
    entry("apps/renrencodex-connect/src/main.rs", "fn main() {}\n"),
    entry("crates/client-native/src/lib.rs", "pub fn native() {}\n"),
    entry("crates/client-protocol/src/lib.rs", "pub fn protocol() {}\n"),
    packageEntry("packages/api-client", "@cloud-machine/api-client"),
    packageEntry("packages/client-contracts", "@cloud-machine/client-contracts"),
    packageEntry("packages/client-core", "@cloud-machine/client-core"),
    packageEntry("packages/native-client-ui", "@cloud-machine/native-client-ui"),
    packageEntry("packages/platform-api", "@cloud-machine/platform-api"),
    packageEntry("packages/workspace-ui", "@cloud-machine/workspace-ui"),
  ];
}

test("accepts a complete client-only source tree", () => {
  expect(() => validatePublicBoundary(validEntries())).not.toThrow();
});

test("accepts reviewed historical snapshot paths but rejects arbitrary path sets", () => {
  const source = { commit: "a".repeat(40), channel: "production" as const };
  const historicalPaths = publicRoots.filter((path) => path !== "apps/renrencodex-connect");
  expect(() =>
    validateManifestMetadata({
      schemaVersion: 2,
      policy: "desktop-public-v1",
      source,
      paths: historicalPaths,
      files: {},
    }),
  ).not.toThrow();
  expect(() =>
    validateManifestMetadata({
      schemaVersion: 2,
      policy: "desktop-public-v1",
      source,
      paths: historicalPaths.slice(1),
      files: {},
    }),
  ).toThrow("public snapshot manifest metadata is invalid");
});

test("requires every allowlisted public root", () => {
  const entries = validEntries().filter(
    (candidate) => !candidate.path.startsWith(`${publicRoots.at(-1)}/`),
  );
  expect(() => validatePublicBoundary(entries)).toThrow(
    "packages/workspace-ui: required public path is missing",
  );
});

test("rejects files outside the allowlist and private package edges", () => {
  const entries = validEntries();
  entries.push(entry("apps/api/src/server.ts"));
  entries.push(
    packageEntry("packages/api-client", "@cloud-machine/api-client", {
      "@cloud-machine/protocol": "workspace:*",
    }),
  );
  entries.push(
    entry(
      "packages/api-client/src/private.ts",
      'import "@cloud-machine/machine-connection-ticket";\n',
    ),
  );
  expect(() => validatePublicBoundary(entries)).toThrow(/outside public allowlist/);
  expect(() => validatePublicBoundary(entries)).toThrow(/private or missing workspace dependency/);
  expect(() => validatePublicBoundary(entries)).toThrow(/private package reference/);
});

test("rejects relative imports that escape the public tree", () => {
  const entries = validEntries();
  entries.push(entry("apps/desktop/src/escape.ts", 'import "../../../apps/api/src/server";\n'));
  expect(() => validatePublicBoundary(entries)).toThrow(/relative import escapes public allowlist/);
});

test("rejects credentials, private paths, server configuration and legacy Gateway auth", () => {
  const entries = validEntries();
  const privateKey = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const credentialUrl = ["postgres://service", "secret@database.example/app"].join(":");
  const privateCheckout = ["/root", "renrencodex/private"].join("/");
  const secretName = ["JWT", "SECRET"].join("_");
  const legacyTicket = ["/terminal?", "token=access-token"].join("");
  entries.push(
    entry(
      "apps/desktop/src/unsafe.ts",
      [privateKey, credentialUrl, privateCheckout, secretName, legacyTicket].join("\n"),
    ),
  );
  expect(() => validatePublicBoundary(entries)).toThrow(/private key material/);
  expect(() => validatePublicBoundary(entries)).toThrow(/credential-bearing connection URL/);
  expect(() => validatePublicBoundary(entries)).toThrow(/private checkout path/);
  expect(() => validatePublicBoundary(entries)).toThrow(/server secret\/config name/);
  expect(() => validatePublicBoundary(entries)).toThrow(/legacy Gateway access-token query/);
});

test("rejects encrypted and vendor-specific private key envelopes", () => {
  for (const kind of ["ENCRYPTED", "DSA", "PGP"]) {
    const entries = validEntries();
    const suffix = kind === "PGP" ? "PRIVATE KEY BLOCK-----" : "PRIVATE KEY-----";
    entries.push(
      entry("apps/desktop/src/unsafe.pem", [["-----BEGIN", kind, suffix].join(" ")].join("\n")),
    );
    expect(() => validatePublicBoundary(entries)).toThrow(/private key material/);
  }
});

test("rejects local, URL, Git and missing workspace dependency sources", () => {
  for (const version of [
    ["file", "../../../packages/protocol"].join(":"),
    ["link", "../../../packages/protocol"].join(":"),
    ["git+ssh", "//git@private.example/internal.git"].join(":"),
    ["github", "private/internal"].join(":"),
    ["npm", "@cloud-machine/protocol@1.0.0"].join(":"),
    "private/internal#main",
    "~/private/package",
    "C:\\private\\package",
    ["https", "//user:secret@private.example/internal.tgz"].join(":"),
  ]) {
    const entries = validEntries();
    entries.push(
      packageEntry("packages/api-client", "@cloud-machine/api-client", {
        "private-alias": version,
      }),
    );
    expect(() => validatePublicBoundary(entries)).toThrow(/local, URL or Git source/);
  }
  const entries = validEntries();
  entries.push(
    packageEntry("packages/api-client", "@cloud-machine/api-client", {
      "missing-workspace": "workspace:*",
    }),
  );
  expect(() => validatePublicBoundary(entries)).toThrow(/missing workspace dependency/);
});

test("rejects Cargo Git dependencies and path dependencies that escape the public tree", () => {
  const pathEntries = validEntries();
  pathEntries.push(
    entry(
      "crates/client-native/Cargo.toml",
      '[dependencies]\nprivate = { path = "../../packages/protocol" }\n',
    ),
  );
  expect(() => validatePublicBoundary(pathEntries)).toThrow(/Cargo path escapes/);

  const absolutePathEntries = validEntries();
  absolutePathEntries.push(
    entry(
      "crates/client-native/Cargo.toml",
      '[dependencies]\nprivate = { path = "C:/private/protocol" }\n',
    ),
  );
  expect(() => validatePublicBoundary(absolutePathEntries)).toThrow(
    /not a safe repository-relative path/,
  );

  const gitEntries = validEntries();
  gitEntries.push(
    entry(
      "crates/client-native/Cargo.toml",
      '[dependencies]\nprivate = { git = "ssh://git@private.example/internal.git" }\n',
    ),
  );
  expect(() => validatePublicBoundary(gitEntries)).toThrow(/Cargo Git dependencies/);
});

test("scans the complete public repository allowlist, secret content and credential filenames", () => {
  const safe = [
    entry(".gitattributes", "* text=auto eol=lf\n"),
    entry("README.md", "# Desktop\n"),
    entry("docs/backend-api.md", "# Backend API\n"),
    entry("scripts/check.ts"),
  ];
  expect(() => validatePublicRepository(safe)).not.toThrow();
  expect(() => validatePublicRepository([...safe, entry("infra/private.ts")])).toThrow(
    /outside public repository allowlist/,
  );
  expect(() =>
    validatePublicRepository([...safe, entry("packaging/signing.p12", "binary-placeholder")]),
  ).toThrow(/sensitive credential filename/);
  expect(() =>
    validatePublicRepository([...safe, entry("packaging/release.ppk", "binary-placeholder")]),
  ).toThrow(/sensitive credential filename/);
  expect(() =>
    validatePublicRepository([...safe, entry("scripts/.envrc", "export SAFE=value\n")]),
  ).toThrow(/sensitive credential filename/);
  const encryptedKey = ["-----BEGIN", "ENCRYPTED PRIVATE KEY-----"].join(" ");
  expect(() => validatePublicRepository([...safe, entry("README.md", encryptedKey)])).toThrow(
    /private key material/,
  );
  expect(() =>
    validatePublicRepository([...safe, entry("packaging/archive.zip", encryptedKey)]),
  ).toThrow(/private key material/);
});

test("rejects stale private workspaces and local or Git sources in dependency locks", () => {
  const packageManifest = packageEntry("packages/api-client", "@cloud-machine/api-client");
  expect(() =>
    validatePublicRepository([
      packageManifest,
      entry("bun.lock", '"@cloud-machine/protocol": "workspace:*"\n'),
    ]),
  ).toThrow(/private or missing workspace dependency/);
  expect(() =>
    validatePublicRepository([
      packageManifest,
      entry("bun.lock", '"private": "git+ssh://git@private.example/internal.git"\n'),
    ]),
  ).toThrow(/local or Git dependency source/);
  expect(() =>
    validatePublicRepository([
      packageManifest,
      entry("Cargo.lock", 'source = "git+https://example.com/private.git"\n'),
    ]),
  ).toThrow(/Git dependency source/);
});

test("scans every reachable Git revision instead of only the current public tree", () => {
  const safeRepository = historyRepository([{ "README.md": "# Public Desktop\n" }]);
  const forbiddenPathRepository = historyRepository([
    { "README.md": "# Public Desktop\n" },
    { "infra/private.ts": "export {};\n" },
    { "infra/private.ts": null },
  ]);
  const privateKey = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const historicalSecretRepository = historyRepository([
    { "README.md": "# Public Desktop\n" },
    { "README.md": privateKey },
    { "README.md": "# Public Desktop\n" },
  ]);
  const historicalBlockerRepository = historyRepository([
    { "README.md": "# Public Desktop\n", "PUBLICATION_BLOCKED.md": "blocked\n" },
    { "PUBLICATION_BLOCKED.md": null },
  ]);
  try {
    expect(() => validatePublicRepositoryHistory(safeRepository)).not.toThrow();
    expect(() => validatePublicRepositoryHistory(forbiddenPathRepository)).toThrow(
      /outside public repository allowlist/,
    );
    expect(() => validatePublicRepositoryHistory(historicalSecretRepository)).toThrow(
      /private key material/,
    );
    expect(() => validatePublicRepositoryHistory(historicalBlockerRepository)).toThrow(
      /still reachable/,
    );
  } finally {
    rmSync(safeRepository, { recursive: true, force: true });
    rmSync(forbiddenPathRepository, { recursive: true, force: true });
    rmSync(historicalSecretRepository, { recursive: true, force: true });
    rmSync(historicalBlockerRepository, { recursive: true, force: true });
  }
});

test("requires complete MIT publication documents", () => {
  const reviewedLicenseFixture = "reviewed MIT fixture\n";
  const fixtureDigest = createHash("sha256").update(reviewedLicenseFixture).digest("hex");
  const valid = {
    LICENSE: reviewedLicenseFixture,
    NOTICE: "RenrenCodex Desktop\n",
    "README.md": "# RenrenCodex Desktop\n",
    "SECURITY.md": "# Security\n",
    "CONTRIBUTING.md": "# Contributing\n",
    "TRADEMARKS.md": "# Trademarks\n",
  };
  expect(() => validatePublicationDocuments(valid, fixtureDigest)).not.toThrow();
  expect(() => validatePublicationDocuments(valid)).toThrow(/exactly match/);
  expect(() => validatePublicationDocuments({ ...valid, NOTICE: "" })).toThrow(
    /publication documents are missing or empty: NOTICE/,
  );
  expect(() =>
    validatePublicationDocuments({
      ...valid,
      LICENSE: "Copyright RenrenCodex. All rights reserved. Proprietary software.",
    }),
  ).toThrow(/exactly match/);
});

test("requires stable checkouts, MIT package metadata and a publication-ready README", () => {
  const valid = {
    ".gitattributes": `* text=auto eol=lf

*.icns binary
*.ico binary
*.png binary
*.ttf binary
*.woff2 binary
*.wasm binary
`,
    "Cargo.toml": '[workspace]\nresolver = "2"\n\n[workspace.package]\nlicense = "MIT"\n',
    "package.json": '{"name":"renrencodex-desktop","license":"MIT"}\n',
    "README.md": "# RenrenCodex Desktop\n",
  };
  expect(() => validatePublicationMetadata(valid)).not.toThrow();
  expect(() =>
    validatePublicationMetadata({
      ...valid,
      ".gitattributes": "* text=auto\n",
    }),
  ).toThrow(/must enforce LF text checkouts/);
  expect(() =>
    validatePublicationMetadata({
      ...valid,
      "Cargo.toml": '[workspace.package]\nlicense = "UNLICENSED"\n',
    }),
  ).toThrow(/Cargo workspace license metadata/);
  expect(() =>
    validatePublicationMetadata({
      ...valid,
      "package.json": '{"name":"renrencodex-desktop","license":"UNLICENSED"}\n',
    }),
  ).toThrow(/package.json license metadata/);
  expect(() =>
    validatePublicationMetadata({
      ...valid,
      "README.md": "This repository is not publication-ready yet.",
    }),
  ).toThrow(/README.md still describes/);
});

test("a publication blocker never relaxes checks in a public GitHub repository", () => {
  expect(() => validateCiRepositoryVisibility("private", true, true)).not.toThrow();
  expect(() => validateCiRepositoryVisibility("internal", true, true)).not.toThrow();
  expect(() => validateCiRepositoryVisibility("public", false, true)).not.toThrow();
  expect(() => validateCiRepositoryVisibility("public", true, true)).toThrow(
    /cannot be used to relax checks in a public repository/,
  );
  expect(() => validateCiRepositoryVisibility(undefined, true, true)).toThrow(
    /must provide PUBLICATION_REPOSITORY_VISIBILITY/,
  );
});
