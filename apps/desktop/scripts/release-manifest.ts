export const DESKTOP_UPDATE_BASE_URL =
  "https://renrencodex.com/downloads/desktop/stable/windows-x86_64";

export interface DesktopReleaseManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: {
    "windows-x86_64": {
      url: string;
      signature: string;
    };
  };
}

export function parseStableVersion(value: string): [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`Desktop release version must be stable SemVer: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareStableVersions(left: string, right: string): number {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function assertNewerRelease(version: string, publishedVersion: string | null): void {
  parseStableVersion(version);
  if (publishedVersion !== null && compareStableVersions(version, publishedVersion) <= 0) {
    throw new Error(`Desktop release ${version} must be newer than published ${publishedVersion}`);
  }
}

export function highestPublishedVersion(versions: ReadonlyArray<string | null>): string | null {
  let highest: string | null = null;
  for (const version of versions) {
    if (version === null) continue;
    parseStableVersion(version);
    if (highest === null || compareStableVersions(version, highest) > 0) highest = version;
  }
  return highest;
}

export function buildDesktopReleaseManifest(input: {
  version: string;
  notes: string;
  publishedAt: string;
  signature: string;
}): DesktopReleaseManifest {
  parseStableVersion(input.version);
  const notes = input.notes
    .trim()
    .replace(/^\uFEFF/, "")
    .trim();
  const signature = input.signature.trim();
  if (!notes) throw new Error("Desktop release notes must not be empty");
  if (!signature) throw new Error("Desktop updater signature must not be empty");
  if (!Number.isFinite(Date.parse(input.publishedAt))) {
    throw new Error("Desktop release publication date must be RFC 3339");
  }
  return {
    version: input.version,
    notes,
    pub_date: input.publishedAt,
    platforms: {
      "windows-x86_64": {
        url: `${DESKTOP_UPDATE_BASE_URL}/renrencodex-desktop-${input.version}-x64.msi`,
        signature,
      },
    },
  };
}

export function readPublishedVersion(value: unknown): string {
  if (!value || typeof value !== "object") throw new Error("Published manifest is not an object");
  const version = (value as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error("Published manifest has no version");
  parseStableVersion(version);
  return version;
}
