export const MAX_EXTERNAL_PREVIEW_IMAGES = 64;
export const PREVIEW_IMAGE_CSP = "img-src 'self' data: blob: https:";

export type PreviewIssueKind =
  | "external-blocked"
  | "invalid-reference"
  | "local-read-failed"
  | "external-load-failed"
  | "resource-limit";

export interface PreviewResourceIssue {
  reference: string;
  kind: PreviewIssueKind;
  message: string;
}

export class PreviewResourceError extends Error {
  constructor(
    readonly kind: PreviewIssueKind,
    message: string,
  ) {
    super(message);
  }
}

export function previewResourceIssue(reference: string, error: unknown): PreviewResourceIssue {
  return {
    reference,
    kind: error instanceof PreviewResourceError ? error.kind : "local-read-failed",
    message: error instanceof Error ? error.message : "本地资源读取失败",
  };
}

export type PreviewImageReference =
  | { kind: "local" }
  | { kind: "external"; url: string; requestKey: string }
  | { kind: "invalid"; message: string };

/** Only classifies the initial URL; no DNS resolution, fetch, or implicit scheme upgrade. */
export function classifyPreviewImageReference(
  reference: string,
  applicationOrigin: string,
): PreviewImageReference {
  const invalid = { kind: "invalid", message: "图片地址不允许" } as const;
  if ([...reference].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    return invalid;
  const raw = reference.trim();
  if (!raw || raw.includes("\\") || raw.startsWith("//")) return invalid;
  // Existing local/data-image validation remains in the local resource reader.
  if (!/^[a-z][a-z\d+.-]*:/i.test(raw) || /^data:/i.test(raw)) return { kind: "local" };
  if (!/^https:\/\//i.test(raw)) return invalid;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid;
  }
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !hostname.includes(".") ||
    hostname.includes(":") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  )
    return invalid;
  try {
    const application = new URL(applicationOrigin);
    if (
      url.protocol === application.protocol &&
      hostname === application.hostname.toLowerCase().replace(/\.+$/, "") &&
      url.port === application.port
    )
      return invalid;
  } catch {
    // Opaque native/test origins cannot equal an HTTPS origin.
  }
  url.hostname = hostname;
  // SVG fragments select a view, but do not identify a separate network resource.
  const imageUrl = url.href;
  url.hash = "";
  return { kind: "external", url: imageUrl, requestKey: url.href };
}
