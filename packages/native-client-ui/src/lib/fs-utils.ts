/**
 * 文件管理 UI 纯逻辑工具（路径处理 / 树排序 / Monaco language 推断 / 二进制检测）。
 * 全部为 posix 路径（远端是 Linux VM），不依赖 DOM，供单测覆盖。
 */
import type { FsEntry } from "@cloud-machine/client-contracts";

/** 规范化 posix 路径：折叠重复 "/" 与 "."，解析 ".."，保证以 "/" 开头。 */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

/** 拼接目录与子名。 */
export function joinPath(dir: string, name: string): string {
  return normalizePath(`${dir}/${name}`);
}

/** 父目录（"/" 的父目录仍是 "/"）。 */
export function parentPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === "/") return "/";
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "/" : normalized.slice(0, idx);
}

/** 路径最后一段。 */
export function baseName(path: string): string {
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf("/");
  return normalized.slice(idx + 1);
}

/** 文件或目录移动/重命名后，将已打开的子路径同步映射到新位置。 */
export function remapMovedPath(path: string, from: string, to: string, isDir: boolean): string {
  return path === from
    ? to
    : isDir && path.startsWith(`${from}/`)
      ? `${to}${path.slice(from.length)}`
      : path;
}

export interface DirectoryNavigationState {
  currentDir: string;
  backStack: string[];
}

/** 进入目录并记录来源；重复进入当前目录不产生无意义历史。 */
export function visitDirectory(
  state: DirectoryNavigationState,
  target: string,
): DirectoryNavigationState {
  const currentDir = normalizePath(state.currentDir);
  const nextDir = normalizePath(target);
  return nextDir === currentDir
    ? { currentDir, backStack: state.backStack }
    : { currentDir: nextDir, backStack: [...state.backStack, currentDir] };
}

/** 返回最近访问目录；调用方应先确认目标目录仍可访问。 */
export function returnDirectory(state: DirectoryNavigationState): DirectoryNavigationState {
  const previous = state.backStack.at(-1);
  return previous === undefined
    ? state
    : { currentDir: previous, backStack: state.backStack.slice(0, -1) };
}

/** 目录移动后同步当前目录与历史，避免导航回旧路径。 */
export function remapDirectoryNavigation(
  state: DirectoryNavigationState,
  from: string,
  to: string,
  isDir: boolean,
): DirectoryNavigationState {
  return {
    currentDir: remapMovedPath(state.currentDir, from, to, isDir),
    backStack: state.backStack.map((path) => remapMovedPath(path, from, to, isDir)),
  };
}

/** 删除目录后回到其父目录，并清掉已失效的历史位置。 */
export function removeDirectoryNavigation(
  state: DirectoryNavigationState,
  removedPath: string,
  isDir: boolean,
): DirectoryNavigationState {
  const removed = normalizePath(removedPath);
  const matches = (path: string) =>
    path === removed || (isDir && path.startsWith(`${removed === "/" ? "" : removed}/`));
  return {
    currentDir: matches(state.currentDir) ? parentPath(removed) : state.currentDir,
    backStack: state.backStack.filter((path) => !matches(path)),
  };
}

/** 面包屑段："/a/b/c" → [{name:"a",path:"/a"},{name:"b",path:"/a/b"},…]。 */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  const normalized = normalizePath(path);
  if (normalized === "/") return [];
  const segs = normalized.split("/").filter(Boolean);
  return segs.map((name, i) => ({ name, path: "/" + segs.slice(0, i + 1).join("/") }));
}

/** 树节点排序：目录在前，同类按名称（localeCompare，大小写不敏感优先）。 */
export function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    const dirA = a.type === "directory" ? 0 : 1;
    const dirB = b.type === "directory" ? 0 : 1;
    if (dirA !== dirB) return dirA - dirB;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** 按扩展名推断 Monaco language id（未匹配走 plaintext）。 */
export function languageForPath(path: string): string {
  const name = baseName(path).toLowerCase();
  // 无扩展名的特殊文件名
  const byFileName: Record<string, string> = {
    dockerfile: "dockerfile",
    makefile: "makefile",
    ".gitignore": "ini",
    ".env": "ini",
  };
  if (byFileName[name]) return byFileName[name]!;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const byExt: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    md: "markdown",
    markdown: "markdown",
    svg: "xml",
    py: "python",
    rs: "rust",
    go: "go",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    ini: "ini",
    cfg: "ini",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    sql: "sql",
    xml: "xml",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    hpp: "cpp",
    java: "java",
    rb: "ruby",
    php: "php",
    lua: "lua",
    dockerfile: "dockerfile",
    tf: "hcl",
  };
  return byExt[ext] ?? "plaintext";
}

/** 二进制探测：前若干字节内含 NUL 即视为二进制（不可文本编辑）。 */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, Math.min(bytes.length, 8192));
  return probe.includes(0);
}

/** 人类可读大小。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}
