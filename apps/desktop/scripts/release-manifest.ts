export const DESKTOP_UPDATE_BASE_URL = "https://renrencodex.com/downloads/desktop/stable";

export type DesktopUpdatePlatform =
  "windows-x86_64" | "darwin-aarch64" | "darwin-x86_64" | "linux-x86_64";

export interface DesktopReleasePlatform {
  url: string;
  signature: string;
}

export interface DesktopReleaseManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Partial<Record<DesktopUpdatePlatform, DesktopReleasePlatform>>;
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

function releaseMetadata(input: {
  version: string;
  notes: string;
  publishedAt: string;
}): Pick<DesktopReleaseManifest, "version" | "notes" | "pub_date"> {
  parseStableVersion(input.version);
  const notes = input.notes
    .trim()
    .replace(/^\uFEFF/, "")
    .trim();
  if (!notes) throw new Error("Desktop release notes must not be empty");
  if (!Number.isFinite(Date.parse(input.publishedAt))) {
    throw new Error("Desktop release publication date must be RFC 3339");
  }
  return {
    version: input.version,
    notes,
    pub_date: input.publishedAt,
  };
}

function updaterSignature(value: string, platform: string): string {
  const signature = value.trim();
  if (!signature) throw new Error(`Desktop ${platform} updater signature must not be empty`);
  return signature;
}

export function desktopUpdateArtifactUrl(platform: DesktopUpdatePlatform, version: string): string {
  parseStableVersion(version);
  switch (platform) {
    case "windows-x86_64":
      return `${DESKTOP_UPDATE_BASE_URL}/windows-x86_64/renrencodex-desktop-${version}-x64.msi`;
    case "darwin-aarch64":
    case "darwin-x86_64":
      return `${DESKTOP_UPDATE_BASE_URL}/macos-universal/renrencodex-desktop-${version}-universal.app.tar.gz`;
    case "linux-x86_64":
      return `${DESKTOP_UPDATE_BASE_URL}/linux-x86_64/renrencodex-desktop-${version}-x86_64.AppImage`;
  }
}

export function buildWindowsDesktopReleaseManifest(input: {
  version: string;
  notes: string;
  publishedAt: string;
  signature: string;
}): DesktopReleaseManifest {
  const metadata = releaseMetadata(input);
  return {
    ...metadata,
    platforms: {
      "windows-x86_64": {
        url: desktopUpdateArtifactUrl("windows-x86_64", input.version),
        signature: updaterSignature(input.signature, "Windows"),
      },
    },
  };
}

export function buildDesktopReleaseManifest(input: {
  version: string;
  notes: string;
  publishedAt: string;
  signatures: {
    windowsX86_64: string;
    macosUniversal: string;
    linuxX86_64: string;
  };
}): DesktopReleaseManifest {
  const metadata = releaseMetadata(input);
  const windowsSignature = updaterSignature(input.signatures.windowsX86_64, "Windows");
  const macosSignature = updaterSignature(input.signatures.macosUniversal, "macOS");
  const linuxSignature = updaterSignature(input.signatures.linuxX86_64, "Linux");
  return {
    ...metadata,
    platforms: {
      "windows-x86_64": {
        url: desktopUpdateArtifactUrl("windows-x86_64", input.version),
        signature: windowsSignature,
      },
      "darwin-aarch64": {
        url: desktopUpdateArtifactUrl("darwin-aarch64", input.version),
        signature: macosSignature,
      },
      "darwin-x86_64": {
        url: desktopUpdateArtifactUrl("darwin-x86_64", input.version),
        signature: macosSignature,
      },
      "linux-x86_64": {
        url: desktopUpdateArtifactUrl("linux-x86_64", input.version),
        signature: linuxSignature,
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
