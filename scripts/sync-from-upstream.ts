import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(repositoryRoot, "desktop-shared-snapshot.json");
const publicationBlockerPath = resolve(repositoryRoot, "PUBLICATION_BLOCKED.md");
const requiredPublicationDocuments = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "TRADEMARKS.md",
] as const;

const EXPECTED_GIT_ATTRIBUTES = `* text=auto eol=lf

*.icns binary
*.ico binary
*.png binary
*.ttf binary
*.woff2 binary
*.wasm binary
`;

const MIT_LICENSE_SHA256 = "f8efe6e0b006be848f7fe9aca9c9de304780f94ae3feb803ba9d86ca1830eb67";
const LEGACY_APACHE_2_0_LICENSE_SHA256 =
  "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
const REVIEWED_LICENSE_SHA256 = new Set([MIT_LICENSE_SHA256, LEGACY_APACHE_2_0_LICENSE_SHA256]);

const publicManagedPaths = [
  "apps/desktop",
  "crates/client-native",
  "crates/client-protocol",
  "packages/api-client",
  "packages/client-contracts",
  "packages/client-core",
  "packages/native-client-ui",
  "packages/platform-api",
  "packages/workspace-ui",
] as const;

const publicRepositoryFiles = new Set([
  ".gitattributes",
  ".gitignore",
  ".prettierignore",
  ".prettierrc",
  "AGENTS.md",
  "Cargo.lock",
  "Cargo.toml",
  "CONTRIBUTING.md",
  "LICENSE",
  "NOTICE",
  "PUBLICATION_BLOCKED.md",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
  "bun.lock",
  "bunfig.toml",
  "desktop-shared-snapshot.json",
  "eslint.config.js",
  "package.json",
  "tsconfig.base.json",
]);
const publicRepositoryRoots = [".github/workflows", "docs", "packaging", "scripts"] as const;
const expectedWorkspacePackages = new Map<string, string>([
  ["apps/desktop/package.json", "@cloud-machine/desktop"],
  ["packages/api-client/package.json", "@cloud-machine/api-client"],
  ["packages/client-contracts/package.json", "@cloud-machine/client-contracts"],
  ["packages/client-core/package.json", "@cloud-machine/client-core"],
  ["packages/native-client-ui/package.json", "@cloud-machine/native-client-ui"],
  ["packages/platform-api/package.json", "@cloud-machine/platform-api"],
  ["packages/workspace-ui/package.json", "@cloud-machine/workspace-ui"],
]);

const secretContentPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN (?:[A-Z0-9][A-Z0-9 -]* )?PRIVATE KEY(?: BLOCK)?-----/, "private key material"],
  [
    /\b(?:https?|wss?|ssh|git\+ssh|postgres(?:ql)?|redis):\/\/[^\s/@:]+:[^\s/@]+@/i,
    "credential-bearing connection URL",
  ],
  [/\bgh[pousr]_[A-Za-z0-9]{36,255}\b/, "GitHub access token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,255}\b/, "GitHub fine-grained access token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bAKID[0-9A-Za-z]{32}\b/, "Tencent Cloud secret id"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\bglpat-[0-9A-Za-z_-]{20,}\b/, "GitLab access token"],
  [/\bnpm_[0-9A-Za-z]{36}\b/, "npm access token"],
  [/\bxox[baprs]-[0-9A-Za-z-]{20,}\b/, "Slack access token"],
  [/\bsk_(?:live|prod)_[0-9A-Za-z]{16,}\b/, "live service secret"],
  [/\bsk-(?:proj-)?[0-9A-Za-z_-]{20,}\b/, "API secret key"],
  [/\/root\/renrencodex(?:\/|\b)/, "private checkout path"],
  [/\/opt\/renrencodex(?:\/|\b)/, "private deployment path"],
];

// Accepted only so the existing private staging snapshot remains reproducible while the
// new allowlisted upstream commit is awaiting review. Keep only the digest here so a future
// schema v2 public tree does not retain private path or repository metadata in this script.
const LEGACY_MANAGED_PATHS_SHA256 =
  "e1cc804557d565e993ed113279e02aa575ccea8b20f68fe971a843aec5e7ec47";

type SnapshotSource = { commit: string; channel: "main" | "production" };
type ManifestV1 = {
  schemaVersion: 1;
  source: SnapshotSource & { repository: string };
  paths: readonly string[];
  files: Record<string, string>;
};
type ManifestV2 = {
  schemaVersion: 2;
  policy: "desktop-public-v1";
  source: SnapshotSource;
  paths: readonly string[];
  files: Record<string, string>;
};
type Manifest = ManifestV1 | ManifestV2;
export type TreeEntry = {
  mode: "100644" | "100755";
  object: string;
  path: string;
  content: Buffer;
};

function git(cwd: string, args: string[], encoding: BufferEncoding | null = "utf8") {
  return execFileSync("git", args, { cwd, encoding, maxBuffer: 1024 * 1024 * 1024 });
}

function hash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizedPath(path: string): string {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`unsafe repository path: ${path}`);
  }
  return path;
}

function targetPath(path: string): string {
  const target = resolve(repositoryRoot, normalizedPath(path));
  if (!target.startsWith(repositoryRoot + sep)) throw new Error(`path escaped repository: ${path}`);
  return target;
}

function parseArguments() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--check") return { mode: "check" } as const;
  if (args.length === 1 && args[0] === "--ci") return { mode: "ci" } as const;
  if (args.length === 1 && args[0] === "--public-ready") return { mode: "public-ready" } as const;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("invalid arguments");
    values.set(key, value);
  }
  const sourceRepo = values.get("--source-repo");
  const ref = values.get("--ref");
  const channel = values.get("--channel");
  if (!sourceRepo || !ref || (channel !== "main" && channel !== "production")) {
    throw new Error(
      "usage: --source-repo <path> --ref <40-character-sha> --channel <main|production>",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error("--ref must be a full lowercase commit SHA");
  return { mode: "sync", sourceRepo: resolve(sourceRepo), ref, channel } as const;
}

function readManifest(): Manifest {
  if (!existsSync(manifestPath)) throw new Error("snapshot manifest does not exist");
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}

function samePaths(actual: readonly string[], expected: readonly string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function validateManifestMetadata(manifest: Manifest): void {
  if (!/^[0-9a-f]{40}$/.test(manifest.source.commit)) {
    throw new Error("snapshot manifest commit is invalid");
  }
  if (manifest.source.channel !== "main" && manifest.source.channel !== "production") {
    throw new Error("snapshot manifest channel is invalid");
  }
  if (manifest.schemaVersion === 1) {
    if (
      typeof manifest.source.repository !== "string" ||
      manifest.source.repository.length === 0 ||
      hash(Buffer.from(JSON.stringify(manifest.paths))) !== LEGACY_MANAGED_PATHS_SHA256
    ) {
      throw new Error("legacy snapshot manifest metadata is invalid");
    }
    return;
  }
  if (manifest.policy !== "desktop-public-v1" || !samePaths(manifest.paths, publicManagedPaths)) {
    throw new Error("public snapshot manifest metadata is invalid");
  }
}

function verifyRecordedFiles(manifest: Manifest): void {
  const recorded = Object.keys(manifest.files).sort();
  const trackedOutput = git(repositoryRoot, ["ls-files", "-z", "--", ...manifest.paths]) as string;
  const tracked = trackedOutput.split("\0").filter(Boolean).sort();
  if (JSON.stringify(recorded) !== JSON.stringify(tracked)) {
    const missing = recorded.filter((path) => !tracked.includes(path));
    const unexpected = tracked.filter((path) => !recorded.includes(path));
    throw new Error(
      `managed file set differs (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
    );
  }
  for (const path of recorded) {
    const actual = hash(readFileSync(targetPath(path)));
    if (actual !== manifest.files[path]) throw new Error(`hash mismatch: ${path}`);
  }
}

function isPublicPath(path: string): boolean {
  return publicManagedPaths.some((root) => path === root || path.startsWith(`${root}/`));
}

function isPublicRepositoryPath(path: string): boolean {
  return (
    isPublicPath(path) ||
    publicRepositoryFiles.has(path) ||
    publicRepositoryRoots.some((root) => path.startsWith(`${root}/`))
  );
}

function isTextFile(path: string, content: Buffer): boolean {
  if (content.includes(0)) return false;
  return !/\.(?:png|ico|icns|woff2?|pdf|zip|gz)$/i.test(path);
}

function dependencySourceIsPrivateOrLocal(value: string): boolean {
  return (
    /^(?:file|link|portal|git(?:\+[^:]*)?|https?|ssh):/i.test(value) ||
    /^(?:github|gitlab|bitbucket):/i.test(value) ||
    /^npm:@cloud-machine\//.test(value) ||
    /^(?:\.\.?\/|\/)/.test(value) ||
    /^(?:~(?:\/|$)|[A-Za-z]:[\\/])/.test(value) ||
    /^[^\s@]+@[^\s:]+:/.test(value) ||
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.*)?$/.test(value)
  );
}

function validatePackageDependencies(
  packageDocuments: ReadonlyArray<{ path: string; value: Record<string, unknown> }>,
  workspacePackages: ReadonlySet<string>,
  failures: string[],
): void {
  for (const { path, value } of packageDocuments) {
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const dependencies = value[field];
      if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies))
        continue;
      for (const [name, rawVersion] of Object.entries(dependencies)) {
        if (typeof rawVersion !== "string") {
          failures.push(`${path}: dependency ${name} has a non-string version`);
          continue;
        }
        if (dependencySourceIsPrivateOrLocal(rawVersion)) {
          failures.push(`${path}: dependency ${name} uses a local, URL or Git source`);
        }
        if (rawVersion.startsWith("workspace:") && !workspacePackages.has(name)) {
          failures.push(`${path}: missing workspace dependency ${name}`);
        }
        if (name.startsWith("@cloud-machine/")) {
          if (!workspacePackages.has(name)) {
            failures.push(`${path}: private or missing workspace dependency ${name}`);
          } else if (rawVersion !== "workspace:*") {
            failures.push(`${path}: public workspace dependency ${name} must use workspace:*`);
          }
        }
      }
    }
  }
}

function validateCargoSources(entries: readonly TreeEntry[], failures: string[]): void {
  for (const entry of entries) {
    if (!entry.path.endsWith("Cargo.toml") || !isTextFile(entry.path, entry.content)) continue;
    const text = entry.content.toString("utf8");
    for (const match of text.matchAll(/\b(path|git)\s*=\s*(["'])(.*?)\2/g)) {
      const kind = match[1]!;
      const value = match[3]!;
      if (kind === "git") {
        failures.push(`${entry.path}: Cargo Git dependencies are not allowed (${value})`);
        continue;
      }
      if (
        value.startsWith("/") ||
        value.includes("\\") ||
        /^(?:~(?:\/|$)|[A-Za-z]:\/)/.test(value)
      ) {
        failures.push(
          `${entry.path}: Cargo path is not a safe repository-relative path (${value})`,
        );
        continue;
      }
      const resolved = posix.normalize(posix.join(posix.dirname(entry.path), value));
      if (resolved.startsWith("../") || !isPublicPath(resolved)) {
        failures.push(`${entry.path}: Cargo path escapes the public allowlist (${value})`);
      }
    }
  }
}

function validateDependencyLocks(
  entries: readonly TreeEntry[],
  workspacePackages: ReadonlySet<string>,
  failures: string[],
): void {
  for (const entry of entries) {
    const text = entry.content.toString("utf8");
    if (entry.path === "bun.lock") {
      for (const match of text.matchAll(/@cloud-machine\/[A-Za-z0-9-]+/g)) {
        const name = match[0];
        if (!workspacePackages.has(name)) {
          failures.push(`bun.lock: private or missing workspace dependency ${name}`);
        }
      }
      if (
        /(?:file|link|portal|git(?:\+[^:]*)?|github|gitlab|bitbucket|ssh):[^\s"']+/i.test(text) ||
        /https?:\/\/[^\s"']+\.git(?:[#?][^\s"']*)?/i.test(text)
      ) {
        failures.push("bun.lock: local or Git dependency source is not allowed");
      }
    }
    if (entry.path === "Cargo.lock" && /^source\s*=\s*["']git\+/m.test(text)) {
      failures.push("Cargo.lock: Git dependency source is not allowed");
    }
  }
}

function sensitiveRepositoryPath(path: string): boolean {
  const name = posix.basename(path).toLowerCase();
  if (/^\.env(?:\..+)?$/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name))
    return true;
  return (
    /\.(?:key|ppk|p12|pfx|p8|jks|keystore|kdbx|mobileprovision)$/i.test(name) ||
    /^(?:\.envrc|\.netrc|\.npmrc|\.pypirc|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials\.json|service-account\.json)$/.test(
      name,
    )
  );
}

export function validatePublicBoundary(entries: readonly TreeEntry[]): void {
  const failures: string[] = [];
  const presentRoots = new Set<string>();
  const workspacePackages = new Set<string>();
  const packageOwners = new Map<string, string>();
  const packageDocuments: Array<{ path: string; value: Record<string, unknown> }> = [];

  for (const entry of entries) {
    const publicRoot = publicManagedPaths.find(
      (root) => entry.path === root || entry.path.startsWith(`${root}/`),
    );
    if (publicRoot) presentRoots.add(publicRoot);
    else failures.push(`${entry.path}: outside public allowlist`);
    if (!entry.path.endsWith("package.json")) continue;
    try {
      const value = JSON.parse(entry.content.toString("utf8")) as Record<string, unknown>;
      packageDocuments.push({ path: entry.path, value });
      const expectedName = expectedWorkspacePackages.get(entry.path);
      if (!expectedName) {
        failures.push(`${entry.path}: unexpected package manifest in public source tree`);
      } else if (value.name !== expectedName) {
        failures.push(`${entry.path}: package name must be ${expectedName}`);
      }
      if (typeof value.name === "string") {
        const owner = packageOwners.get(value.name);
        if (owner)
          failures.push(`${entry.path}: duplicate workspace package name also used by ${owner}`);
        else packageOwners.set(value.name, entry.path);
        workspacePackages.add(value.name);
      }
    } catch {
      failures.push(`${entry.path}: invalid package.json`);
    }
  }
  for (const root of publicManagedPaths) {
    if (!presentRoots.has(root)) failures.push(`${root}: required public path is missing`);
  }

  validatePackageDependencies(packageDocuments, workspacePackages, failures);
  validateCargoSources(entries, failures);

  const forbiddenContent: ReadonlyArray<readonly [RegExp, string]> = [
    ...secretContentPatterns,
    [
      /\b(?:JWT_SECRET|GATEWAY_INTERNAL_TOKEN|DATABASE_URL|REDIS_URL|INCUS_URL)\b/,
      "server secret/config name",
    ],
    [
      /@cloud-machine\/(?:protocol|admin-contracts|machine-connection-ticket)\b/,
      "private package reference",
    ],
    [
      /\/(?:terminal|rpc|upload|download|search|watch)\?token=/,
      "legacy Gateway access-token query",
    ],
  ];
  const importPattern = /\b(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g;

  for (const entry of entries) {
    const text = entry.content.toString("utf8");
    for (const [pattern, label] of forbiddenContent) {
      if (pattern.test(text)) failures.push(`${entry.path}: contains ${label}`);
    }
    if (!isTextFile(entry.path, entry.content)) continue;
    if (!/\.[cm]?[jt]sx?$/.test(entry.path)) continue;
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1]!;
      const workspaceImport = /^(@cloud-machine\/[^/]+)/.exec(specifier)?.[1];
      if (workspaceImport && !workspacePackages.has(workspaceImport)) {
        failures.push(
          `${entry.path}: source imports private or missing package ${workspaceImport}`,
        );
      }
      if (!specifier.startsWith(".")) continue;
      const resolvedImport = posix.normalize(posix.join(posix.dirname(entry.path), specifier));
      if (resolvedImport.startsWith("../") || !isPublicPath(resolvedImport)) {
        failures.push(`${entry.path}: relative import escapes public allowlist (${specifier})`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`public boundary check failed:\n- ${[...new Set(failures)].join("\n- ")}`);
  }
}

export function validatePublicRepository(entries: readonly TreeEntry[]): void {
  const failures: string[] = [];
  const workspacePackages = new Set<string>();
  const packageDocuments: Array<{ path: string; value: Record<string, unknown> }> = [];

  for (const entry of entries) {
    if (!isPublicRepositoryPath(entry.path)) {
      failures.push(`${entry.path}: outside public repository allowlist`);
    }
    if (sensitiveRepositoryPath(entry.path)) {
      failures.push(`${entry.path}: sensitive credential filename is not allowed`);
    }
    const text = entry.content.toString("utf8");
    for (const [pattern, label] of secretContentPatterns) {
      if (pattern.test(text)) failures.push(`${entry.path}: contains ${label}`);
    }
    if (!isTextFile(entry.path, entry.content)) continue;
    if (!entry.path.endsWith("package.json")) continue;
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      packageDocuments.push({ path: entry.path, value });
      if (typeof value.name === "string") workspacePackages.add(value.name);
    } catch {
      failures.push(`${entry.path}: invalid package.json`);
    }
  }

  validatePackageDependencies(packageDocuments, workspacePackages, failures);
  validateCargoSources(entries, failures);
  validateDependencyLocks(entries, workspacePackages, failures);
  if (failures.length > 0) {
    throw new Error(`public repository check failed:\n- ${[...new Set(failures)].join("\n- ")}`);
  }
}

function normalizedLicenseSha256(value: string): string {
  return hash(Buffer.from(`${value.replace(/\r\n/g, "\n").trimEnd()}\n`));
}

export function validatePublicationDocuments(
  documents: Readonly<Record<string, string | undefined>>,
  expectedLicenseSha256 = MIT_LICENSE_SHA256,
): void {
  const missing = requiredPublicationDocuments.filter(
    (name) => !documents[name] || documents[name]!.trim().length === 0,
  );
  if (missing.length > 0) {
    throw new Error(`publication documents are missing or empty: ${missing.join(", ")}`);
  }
  const license = documents.LICENSE!;
  if (normalizedLicenseSha256(license) !== expectedLicenseSha256) {
    throw new Error("LICENSE must exactly match the reviewed MIT License text");
  }
}

export function validatePublicationMetadata(
  documents: Readonly<Record<string, string | undefined>>,
): void {
  const attributes = documents[".gitattributes"];
  if (
    !attributes ||
    `${attributes.replace(/\r\n/g, "\n").trimEnd()}\n` !== EXPECTED_GIT_ATTRIBUTES
  ) {
    throw new Error(
      ".gitattributes must enforce LF text checkouts and preserve reviewed binary files",
    );
  }
  const cargo = documents["Cargo.toml"];
  if (!cargo) throw new Error("Cargo.toml is missing from the tracked publication tree");
  const workspacePackage = cargo
    .split(/\n(?=\[)/)
    .find((section) => section.trimStart().startsWith("[workspace.package]"));
  if (!workspacePackage || !/^license\s*=\s*"MIT"\s*$/m.test(workspacePackage)) {
    throw new Error('Cargo workspace license metadata must be "MIT"');
  }
  const packageDocument = documents["package.json"];
  if (!packageDocument)
    throw new Error("package.json is missing from the tracked publication tree");
  let packageMetadata: { license?: unknown };
  try {
    packageMetadata = JSON.parse(packageDocument) as { license?: unknown };
  } catch {
    throw new Error("package.json is not valid JSON");
  }
  if (packageMetadata.license !== "MIT") {
    throw new Error('package.json license metadata must be "MIT"');
  }
  const readme = documents["README.md"] ?? "";
  if (/not publication-ready|legacy schema v1|proprietary license/i.test(readme)) {
    throw new Error("README.md still describes a blocked or proprietary source snapshot");
  }
}

export function validateCiRepositoryVisibility(
  visibility: string | undefined,
  publicationBlocked: boolean,
  githubActions = false,
): void {
  const knownVisibility =
    visibility === "public" || visibility === "private" || visibility === "internal";
  if (githubActions && !knownVisibility) {
    throw new Error("GitHub Actions must provide PUBLICATION_REPOSITORY_VISIBILITY");
  }
  if (publicationBlocked && visibility === "public") {
    throw new Error("PUBLICATION_BLOCKED.md cannot be used to relax checks in a public repository");
  }
}

function currentPublicEntries(manifest: ManifestV2): TreeEntry[] {
  return Object.keys(manifest.files).map((path) => ({
    mode: "100644",
    object: "working-tree",
    path,
    content: readFileSync(targetPath(path)),
  }));
}

function currentRepositoryEntries(): TreeEntry[] {
  const index = git(repositoryRoot, ["ls-files", "-s", "-z"]) as string;
  return index
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error(`cannot parse tracked repository entry: ${record}`);
      const [, rawMode, object, stage, rawPath] = match;
      if (stage !== "0")
        throw new Error(`tracked repository entry has an unresolved stage: ${rawPath}`);
      if (rawMode !== "100644" && rawMode !== "100755") {
        throw new Error(`unsupported tracked repository entry: ${rawPath} (${rawMode})`);
      }
      const path = normalizedPath(rawPath!);
      return {
        mode: rawMode as TreeEntry["mode"],
        object: object!,
        path,
        content: readFileSync(targetPath(path)),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function historicalRepositoryEntries(historyRoot: string): TreeEntry[] {
  const raw = git(historyRoot, [
    "log",
    "-m",
    "--root",
    "--format=",
    "--raw",
    "-z",
    "--no-abbrev",
    "--no-renames",
    "HEAD",
  ]) as string;
  const records = raw.split("\0").filter(Boolean);
  if (records.length % 2 !== 0) throw new Error("cannot parse reachable Git history");

  const entries = new Map<string, Omit<TreeEntry, "content">>();
  for (let index = 0; index < records.length; index += 2) {
    const header = records[index]!;
    const path = normalizedPath(records[index + 1]!);
    const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) [A-Z][0-9]*$/.exec(header);
    if (!match) throw new Error(`cannot parse reachable Git history entry: ${header}`);
    const [, oldMode, newMode, oldObject, newObject] = match;
    for (const [mode, object] of [
      [oldMode, oldObject],
      [newMode, newObject],
    ] as const) {
      if (/^0+$/.test(object!)) continue;
      if (mode !== "100644" && mode !== "100755") {
        throw new Error(`unsupported reachable Git history entry: ${path} (${mode})`);
      }
      entries.set(`${object!}\0${path}`, {
        mode,
        object: object!,
        path,
      });
    }
  }

  const contents = new Map<string, Buffer>();
  return [...entries.values()]
    .map((entry) => {
      let content = contents.get(entry.object);
      if (!content) {
        content = git(historyRoot, ["cat-file", "blob", entry.object], null) as Buffer;
        contents.set(entry.object, content);
      }
      return { ...entry, content };
    })
    .sort((left, right) =>
      left.path === right.path
        ? left.object.localeCompare(right.object)
        : left.path.localeCompare(right.path),
    );
}

export function validatePublicRepositoryHistory(historyRoot = repositoryRoot): void {
  const entries = historicalRepositoryEntries(historyRoot);
  validatePublicRepository(entries);

  const failures: string[] = [];
  if (entries.some((entry) => entry.path === "PUBLICATION_BLOCKED.md")) {
    failures.push("PUBLICATION_BLOCKED.md is still reachable; create a fresh public history");
  }
  for (const entry of entries) {
    if (entry.path === "LICENSE") {
      const value = entry.content.toString("utf8");
      if (!REVIEWED_LICENSE_SHA256.has(normalizedLicenseSha256(value))) {
        failures.push("an unreviewed LICENSE is still reachable in public history");
      }
    }
    if (entry.path === "desktop-shared-snapshot.json") {
      try {
        const value = JSON.parse(entry.content.toString("utf8")) as Manifest;
        if (value.schemaVersion !== 2 || value.policy !== "desktop-public-v1") {
          failures.push(
            "a legacy snapshot manifest is still reachable; create a fresh public history",
          );
        } else {
          validateManifestMetadata(value);
        }
      } catch {
        failures.push("an invalid snapshot manifest is still reachable in public history");
      }
    }
    if (
      entry.path === "README.md" &&
      /not publication-ready|legacy schema v1|proprietary license/i.test(
        entry.content.toString("utf8"),
      )
    ) {
      failures.push(
        "a blocked or proprietary README is still reachable; create a fresh public history",
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `public history policy check failed:\n- ${[...new Set(failures)].join("\n- ")}`,
    );
  }
}

function checkSnapshot(publicReady: boolean): void {
  const manifest = readManifest();
  validateManifestMetadata(manifest);
  verifyRecordedFiles(manifest);
  if (manifest.schemaVersion === 1) {
    if (publicReady) throw new Error("legacy schema v1 snapshot is not safe for publication");
    console.warn(
      "Legacy private snapshot verified; publication remains blocked until schema v2 sync.",
    );
    return;
  }
  validatePublicBoundary(currentPublicEntries(manifest));
  const repositoryEntries = currentRepositoryEntries();
  validatePublicRepository(repositoryEntries);
  if (publicReady && existsSync(publicationBlockerPath)) {
    throw new Error(
      "PUBLICATION_BLOCKED.md must be removed only after the schema v2 snapshot review",
    );
  }
  if (publicReady) {
    validatePublicRepositoryHistory();
    const trackedDocuments = Object.fromEntries(
      repositoryEntries
        .filter((entry) => isTextFile(entry.path, entry.content))
        .map((entry) => [entry.path, entry.content.toString("utf8")]),
    );
    validatePublicationDocuments(trackedDocuments);
    validatePublicationMetadata(trackedDocuments);
  }
  console.log(
    `Public snapshot verified: ${Object.keys(manifest.files).length} files at ${manifest.source.commit}`,
  );
}

function sourceEntries(sourceRepo: string, ref: string): TreeEntry[] {
  const tree = git(sourceRepo, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    ref,
    "--",
    ...publicManagedPaths,
  ]) as string;
  const parsed = tree
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/.exec(entry);
      if (!match) throw new Error(`cannot parse tree entry: ${entry}`);
      const [, rawMode, type, object, rawPath] = match;
      if (type !== "blob" || (rawMode !== "100644" && rawMode !== "100755")) {
        throw new Error(`unsupported managed entry: ${rawPath} (${rawMode} ${type})`);
      }
      const mode = rawMode as TreeEntry["mode"];
      const path = normalizedPath(rawPath!);
      const content = git(sourceRepo, ["cat-file", "blob", object!], null) as Buffer;
      return { mode, object: object!, path, content };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (parsed.length === 0) throw new Error("no public managed files found in source commit");
  return parsed;
}

function syncSnapshot(sourceRepo: string, ref: string, channel: "main" | "production"): void {
  if (!statSync(sourceRepo).isDirectory()) throw new Error("--source-repo is not a directory");
  const commit = (git(sourceRepo, ["rev-parse", "--verify", `${ref}^{commit}`]) as string).trim();
  if (commit !== ref) throw new Error("ref did not resolve to the exact requested commit");

  const branchCandidates = [`refs/remotes/origin/${channel}`, `refs/heads/${channel}`, channel];
  const branch = branchCandidates.find((candidate) => {
    try {
      git(sourceRepo, ["rev-parse", "--verify", candidate]);
      return true;
    } catch {
      return false;
    }
  });
  if (!branch) throw new Error(`local source has no ${channel} branch reference`);
  try {
    git(sourceRepo, ["merge-base", "--is-ancestor", ref, branch]);
  } catch {
    throw new Error(`${ref} is not reachable from ${branch}`);
  }

  const entries = sourceEntries(sourceRepo, ref);
  validatePublicBoundary(entries);

  const previous = readManifest();
  validateManifestMetadata(previous);
  const removable = [...new Set([...previous.paths, ...publicManagedPaths])];
  for (const path of removable) rmSync(targetPath(path), { recursive: true, force: true });

  const files: Record<string, string> = {};
  for (const entry of entries) {
    const destination = targetPath(entry.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, entry.content);
    chmodSync(destination, entry.mode === "100755" ? 0o755 : 0o644);
    files[entry.path] = hash(entry.content);
  }

  const manifest: ManifestV2 = {
    schemaVersion: 2,
    policy: "desktop-public-v1",
    source: { commit: ref, channel },
    paths: publicManagedPaths,
    files,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Synced ${entries.length} public files from ${channel}@${ref}`);
  console.log(
    "Run frozen install and all checks; publication remains blocked until review removes PUBLICATION_BLOCKED.md.",
  );
}

if (import.meta.main) {
  try {
    const arguments_ = parseArguments();
    if (arguments_.mode === "check") checkSnapshot(false);
    else if (arguments_.mode === "ci") {
      const publicationBlocked = existsSync(publicationBlockerPath);
      validateCiRepositoryVisibility(
        process.env.PUBLICATION_REPOSITORY_VISIBILITY,
        publicationBlocked,
        process.env.GITHUB_ACTIONS === "true",
      );
      checkSnapshot(!publicationBlocked);
    } else if (arguments_.mode === "public-ready") checkSnapshot(true);
    else syncSnapshot(arguments_.sourceRepo, arguments_.ref, arguments_.channel);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
