export interface LocalDropFile {
  relativePath: string;
  file: File;
}

export interface LocalDropFailure {
  relativePath: string;
  message: string;
}

export interface LocalDropManifest {
  directories: string[];
  files: LocalDropFile[];
  failures: LocalDropFailure[];
  directoryEntriesSupported: boolean;
}

const FATAL_UPLOAD_TRANSPORT_CODES = new Set([
  "RPC_CLOSED",
  "RPC_TIMEOUT",
  "CONNECT_FAILED",
  "UNAUTHENTICATED",
  "MACHINE_OFFLINE",
  "FILE_UPLOAD_CONNECTION_LOST",
]);

/** Whether continuing the remaining upload items would only repeat a channel-wide failure. */
export function isFatalUploadTransportError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && FATAL_UPLOAD_TRANSPORT_CODES.has(code);
}

/**
 * Counts bytes transferred across files without moving backwards when a partially transferred
 * file fails. A new file starts at the highest byte count observed for all previous attempts.
 */
export class LocalUploadByteCounter {
  private transferred = 0;
  private currentFileStart = 0;

  beginFile(): number {
    this.currentFileStart = this.transferred;
    return this.transferred;
  }

  recordFileProgress(written: number): number {
    this.transferred = Math.max(this.transferred, this.currentFileStart + written);
    return this.transferred;
  }

  get value(): number {
    return this.transferred;
  }
}

/** 并发上传时按文件分别记录单调进度，再汇总成不会倒退的批次进度。 */
export class ConcurrentLocalUploadByteCounter {
  private readonly progress = new Map<string, number>();

  recordFileProgress(fileId: string, written: number): number {
    this.progress.set(fileId, Math.max(this.progress.get(fileId) ?? 0, written));
    return this.value;
  }

  get value(): number {
    let total = 0;
    for (const written of this.progress.values()) total += written;
    return total;
  }
}

type OptionalEntryItem = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntry | null;
};

type CapturedItem = { kind: "entry"; entry: FileSystemEntry } | { kind: "file"; file: File };

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "无法读取本地项目";
}

function validSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\0")
  );
}

function relativePath(segments: readonly string[]): string {
  return segments.join("/");
}

function readFileEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirectoryBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function readDirectoryEntries(
  entry: FileSystemDirectoryEntry,
  signal?: AbortSignal,
): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const entries: FileSystemEntry[] = [];
  for (;;) {
    signal?.throwIfAborted();
    const batch = await readDirectoryBatch(reader);
    signal?.throwIfAborted();
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

/** Whether a browser drag contains local file-system items rather than an in-app tree move. */
export function hasLocalFileItems(
  transfer: {
    items: ArrayLike<DataTransferItem>;
    types: ArrayLike<string>;
  } | null,
): boolean {
  if (!transfer) return false;
  if (Array.from(transfer.types).includes("Files")) return true;
  return Array.from(transfer.items).some((item) => item.kind === "file");
}

/** Build the same manifest used by drag-and-drop for the existing file picker. */
export function localFilesManifest(files: ArrayLike<File>): LocalDropManifest {
  const failures: LocalDropFailure[] = [];
  const collected: LocalDropFile[] = [];
  for (const file of Array.from(files)) {
    if (!validSegment(file.name)) {
      failures.push({ relativePath: file.name || "(未命名文件)", message: "文件名无效" });
      continue;
    }
    collected.push({ relativePath: file.name, file });
  }
  return {
    directories: [],
    files: collected,
    failures,
    directoryEntriesSupported: true,
  };
}

/**
 * Capture every DataTransfer entry before the first await, then recursively enumerate it.
 * Browsers protect the drag data store after the synchronous drop callback returns.
 */
export async function collectLocalDropManifest(
  items: ArrayLike<DataTransferItem>,
  signal?: AbortSignal,
): Promise<LocalDropManifest> {
  signal?.throwIfAborted();
  const captured: CapturedItem[] = [];
  const captureFailures: LocalDropFailure[] = [];
  let directoryEntriesSupported = true;

  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const getEntry = (item as OptionalEntryItem).webkitGetAsEntry;
    if (typeof getEntry === "function") {
      const entry = getEntry.call(item);
      if (entry) {
        captured.push({ kind: "entry", entry });
        continue;
      }
    }
    directoryEntriesSupported = false;
    const file = item.getAsFile();
    if (file) captured.push({ kind: "file", file });
    else
      captureFailures.push({
        relativePath: "(未知项目)",
        message: "浏览器未提供可读取的文件或目录条目",
      });
  }

  const directories = new Set<string>();
  const files: LocalDropFile[] = [];
  const failures = [...captureFailures];

  const walk = async (entry: FileSystemEntry, parents: readonly string[]): Promise<void> => {
    signal?.throwIfAborted();
    if (!validSegment(entry.name)) {
      failures.push({
        relativePath: relativePath([...parents, entry.name]) || "(未命名项目)",
        message: "本地路径包含无效名称",
      });
      return;
    }
    const segments = [...parents, entry.name];
    const path = relativePath(segments);
    try {
      if (entry.isDirectory) {
        directories.add(path);
        const children = await readDirectoryEntries(entry as FileSystemDirectoryEntry, signal);
        children.sort((left, right) => left.name.localeCompare(right.name));
        for (const child of children) await walk(child, segments);
      } else if (entry.isFile) {
        const file = await readFileEntry(entry as FileSystemFileEntry);
        signal?.throwIfAborted();
        files.push({ relativePath: path, file });
      } else {
        failures.push({ relativePath: path, message: "不支持的本地项目类型" });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push({ relativePath: path, message: errorMessage(error) });
    }
  };

  for (const item of captured) {
    signal?.throwIfAborted();
    if (item.kind === "entry") await walk(item.entry, []);
    else if (validSegment(item.file.name))
      files.push({ relativePath: item.file.name, file: item.file });
    else
      failures.push({
        relativePath: item.file.name || "(未命名文件)",
        message: "文件名无效",
      });
  }

  return {
    directories: [...directories].sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth || left.localeCompare(right);
    }),
    files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    failures,
    directoryEntriesSupported,
  };
}
