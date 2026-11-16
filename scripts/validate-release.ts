import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import {
  assertNewerRelease,
  highestPublishedVersion,
  readPublishedVersion,
} from "../apps/desktop/scripts/release-manifest";

const OFFICIAL_REPOSITORY = "renrencodex/desktop";
const GITHUB_RELEASES_URL = `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/releases`;
const PUBLIC_MANIFEST_URL = "https://renrencodex.com/downloads/desktop/stable/latest.json";
const PUBLIC_HIGHEST_VERSION_URL = "https://renrencodex.com/downloads/desktop/stable/highest.json";
const repositoryRoot = resolve(import.meta.dir, "..");

interface ReleaseMetadata {
  readonly repository: string;
  readonly refType: string;
  readonly tag: string;
  readonly githubSha: string;
  readonly headSha: string;
  readonly version: string;
  readonly snapshotChannel: unknown;
  readonly snapshotCommit: unknown;
}

export function versionFromReleaseTag(tag: string): string {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag);
  if (!match) throw new Error(`Official Desktop release tag must be v<stable-semver>: ${tag}`);
  return match[1]!;
}

export function validateReleaseMetadata(metadata: ReleaseMetadata): string {
  if (metadata.repository !== OFFICIAL_REPOSITORY) {
    throw new Error(`Official Desktop releases only run in ${OFFICIAL_REPOSITORY}`);
  }
  if (metadata.refType !== "tag") throw new Error("Official Desktop releases require a tag ref");

  const tagVersion = versionFromReleaseTag(metadata.tag);
  if (tagVersion !== metadata.version) {
    throw new Error(
      `Release tag ${metadata.tag} does not match Desktop version ${metadata.version}`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(metadata.githubSha)) {
    throw new Error("GITHUB_SHA must be a full lowercase commit SHA");
  }
  if (metadata.headSha !== metadata.githubSha) {
    throw new Error("Checked-out release commit does not match GITHUB_SHA");
  }
  if (metadata.snapshotChannel !== "production") {
    throw new Error("Official Desktop releases require a production upstream snapshot");
  }
  if (
    typeof metadata.snapshotCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(metadata.snapshotCommit)
  ) {
    throw new Error("Desktop snapshot source commit must be a full lowercase commit SHA");
  }
  return tagVersion;
}

export function stableVersionsFromGitHubReleases(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("GitHub Releases response is not an array");
  const versions: string[] = [];
  for (const release of value) {
    if (!release || typeof release !== "object") {
      throw new Error("GitHub Releases response contains an invalid release");
    }
    const candidate = release as {
      draft?: unknown;
      prerelease?: unknown;
      tag_name?: unknown;
    };
    if (candidate.draft === true || candidate.prerelease === true) continue;
    if (typeof candidate.tag_name !== "string") {
      throw new Error("Published GitHub Release has no tag name");
    }
    try {
      versions.push(versionFromReleaseTag(candidate.tag_name));
    } catch {
      // Ignore unrelated release tag namespaces, but never treat them as Desktop stable versions.
    }
  }
  return versions;
}

async function publishedVersion(url: string): Promise<string | null> {
  const response = await fetch(url, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`Cannot read published Desktop version: HTTP ${response.status}`);
  return readPublishedVersion(await response.json());
}

async function publishedGitHubVersions(): Promise<string[]> {
  const versions: string[] = [];
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  for (let page = 1; page <= 100; page += 1) {
    const response = await fetch(`${GITHUB_RELEASES_URL}?per_page=100&page=${page}`, {
      cache: "no-store",
      headers,
    });
    if (!response.ok) {
      throw new Error(`Cannot read published GitHub Releases: HTTP ${response.status}`);
    }
    const releases = await response.json();
    const pageVersions = stableVersionsFromGitHubReleases(releases);
    versions.push(...pageVersions);
    if ((releases as unknown[]).length < 100) return versions;
  }
  throw new Error("GitHub Releases pagination exceeded the supported limit");
}

export async function assertNewerThanPublishedDesktopRelease(version: string): Promise<void> {
  const [latestVersion, highestVersion, githubVersions] = await Promise.all([
    publishedVersion(PUBLIC_MANIFEST_URL),
    publishedVersion(PUBLIC_HIGHEST_VERSION_URL),
    publishedGitHubVersions(),
  ]);
  assertNewerRelease(
    version,
    highestPublishedVersion([latestVersion, highestVersion, ...githubVersions]),
  );
}

async function main(): Promise<void> {
  const packageJson = (await Bun.file(
    resolve(repositoryRoot, "apps/desktop/package.json"),
  ).json()) as {
    version?: unknown;
  };
  const snapshot = (await Bun.file(
    resolve(repositoryRoot, "desktop-shared-snapshot.json"),
  ).json()) as {
    source?: { channel?: unknown; commit?: unknown };
  };
  if (typeof packageJson.version !== "string") {
    throw new Error("apps/desktop/package.json has no version");
  }

  const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const version = validateReleaseMetadata({
    repository: process.env.GITHUB_REPOSITORY ?? "",
    refType: process.env.GITHUB_REF_TYPE ?? "",
    tag: process.env.GITHUB_REF_NAME ?? "",
    githubSha: process.env.GITHUB_SHA ?? "",
    headSha,
    version: packageJson.version,
    snapshotChannel: snapshot.source?.channel,
    snapshotCommit: snapshot.source?.commit,
  });
  await assertNewerThanPublishedDesktopRelease(version);
  console.log(`Validated official Desktop ${version} release source at ${headSha}`);
}

if (import.meta.main) await main();
