import { baseName, normalizePath, parentPath } from "./fs-utils";

export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_PREVIEW_BYTES = 50 * 1024 * 1024;
export const MAX_PREVIEW_CACHE_BYTES = 100 * 1024 * 1024;
export type PreviewKind = "image" | "svg" | "markdown" | "html" | "pdf" | "audio" | "video";
export interface PreviewFormat {
  kind: PreviewKind;
  mime: string;
}

const formats: Record<string, PreviewFormat> = {};
function register(kind: PreviewKind, mime: string, extensions: string[]) {
  for (const ext of extensions) formats[ext] = { kind, mime };
}
register("image", "image/png", ["png", "apng"]);
register("image", "image/jpeg", ["jpg", "jpeg", "jpe", "jfif"]);
register("image", "image/gif", ["gif"]);
register("image", "image/webp", ["webp"]);
register("image", "image/avif", ["avif"]);
register("image", "image/bmp", ["bmp"]);
register("image", "image/x-icon", ["ico", "cur"]);
register("image", "image/tiff", ["tif", "tiff"]);
register("image", "image/heic", ["heic"]);
register("image", "image/heif", ["heif"]);
register("image", "image/jxl", ["jxl"]);
register("svg", "image/svg+xml", ["svg"]);
register("markdown", "text/markdown", ["md", "markdown"]);
register("html", "text/html", ["html", "htm"]);
register("pdf", "application/pdf", ["pdf"]);
register("audio", "audio/mpeg", ["mp3"]);
register("audio", "audio/wav", ["wav"]);
register("audio", "audio/ogg", ["ogg", "oga", "opus"]);
register("audio", "audio/flac", ["flac"]);
register("audio", "audio/aac", ["aac"]);
register("audio", "audio/mp4", ["m4a"]);
register("audio", "audio/webm", ["weba"]);
register("video", "video/mp4", ["mp4", "m4v"]);
register("video", "video/webm", ["webm"]);
register("video", "video/ogg", ["ogv"]);
register("video", "video/quicktime", ["mov"]);
register("video", "video/x-matroska", ["mkv"]);
register("video", "video/x-msvideo", ["avi"]);
register("video", "video/3gpp", ["3gp"]);

export function isTextPreview(kind: PreviewKind): boolean {
  return kind === "markdown" || kind === "html" || kind === "svg";
}
export function hasPreviewControl(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32);
}
export function previewFormat(path: string, bytes?: Uint8Array): PreviewFormat | null {
  if (bytes) {
    const start = Array.from(bytes.subarray(0, 12));
    const ascii = new TextDecoder().decode(bytes.subarray(0, 12));
    if (ascii.startsWith("%PDF-")) return formats.pdf!;
    if (start.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10") return formats.png!;
    if (start[0] === 255 && start[1] === 216 && start[2] === 255) return formats.jpg!;
    if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) return formats.gif!;
    if (ascii.startsWith("RIFF") && ascii.slice(8) === "WEBP") return formats.webp!;
  }
  const name = baseName(path).toLowerCase();
  return formats[name.slice(name.lastIndexOf(".") + 1)] ?? null;
}

/** 文档 URL 不是平台 URL：只允许工作区内相对路径或工作区根相对路径。 */
export function resolvePreviewPath(
  documentPath: string,
  reference: string,
  rootPath: string,
): string | null {
  const raw = reference.trim();
  if (
    !raw ||
    raw.startsWith("#") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    hasPreviewControl(raw) ||
    /^[a-z][a-z\d+.-]*:/i.test(raw)
  )
    return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.split(/[?#]/)[0]!);
  } catch {
    return null;
  }
  if (
    !decoded ||
    decoded.includes("\\") ||
    hasPreviewControl(decoded) ||
    decoded.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(decoded)
  )
    return null;
  const root = normalizePath(rootPath);
  const path = normalizePath(
    decoded.startsWith("/") ? `${root}/${decoded}` : `${parentPath(documentPath)}/${decoded}`,
  );
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`) ? path : null;
}

/** 对原始预览数据做 LRU 淘汰；编辑缓冲和当前文件永不丢弃。数组尾为最近访问。 */
export function trimPreviewCache<T extends { kind: string; path: string; bytes?: Uint8Array }>(
  tabs: T[],
  activePath: string | null,
  limit = MAX_PREVIEW_CACHE_BYTES,
): T[] {
  let total = tabs.reduce(
    (size, tab) => size + (tab.kind === "preview" ? (tab.bytes?.length ?? 0) : 0),
    0,
  );
  const removed = new Set<T>();
  for (const tab of tabs) {
    if (total <= limit) break;
    if (tab.kind !== "preview" || tab.path === activePath) continue;
    total -= tab.bytes?.length ?? 0;
    removed.add(tab);
  }
  return removed.size ? tabs.filter((tab) => !removed.has(tab)) : tabs;
}
