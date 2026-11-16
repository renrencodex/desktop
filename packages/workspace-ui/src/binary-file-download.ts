import {
  FS_DOWNLOAD_ERROR_CHANGED,
  FS_DOWNLOAD_IDLE_TIMEOUT_MS,
  fileDownloadServerMessageSchema,
} from "@cloud-machine/client-contracts";

export const FILE_DOWNLOAD_IDLE_TIMEOUT_MS = FS_DOWNLOAD_IDLE_TIMEOUT_MS;
export const FILE_DOWNLOAD_MAX_TRANSIENT_RETRIES = 2;
export const FILE_DOWNLOAD_MEMORY_FALLBACK_MAX_BYTES = 128 * 1024 * 1024;

const RETRYABLE_CODES = new Set([
  "FILE_DOWNLOAD_CONNECTION_LOST",
  "CONNECT_FAILED",
  "MACHINE_OFFLINE",
  "RPC_CLOSED",
  "RPC_TIMEOUT",
]);
const OPFS_PREFIX = ".renrencodex-download-v1-";
const OPFS_STALE_AFTER_MS = 24 * 60 * 60_000;
const OPFS_LOCK_PREFIX = "renrencodex:file-download:";
const activeOpfsEntries = new Set<string>();
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

export class BinaryFileDownloadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BinaryFileDownloadError";
  }
}

export class FileDownloadStalledError extends BinaryFileDownloadError {
  constructor(readonly idleTimeoutMs: number) {
    super("FILE_DOWNLOAD_STALLED", `连续 ${Math.round(idleTimeoutMs / 1000)} 秒没有下载进度`);
    this.name = "FileDownloadStalledError";
  }
}

export interface DownloadArtifact {
  blob: Blob;
  size: number;
  archive?: DirectoryDownloadCompletion;
  dispose(): Promise<void>;
}

export interface DirectoryDownloadProgress {
  processedEntries: number;
  sourceBytes: number;
  skippedEntries: number;
}

export interface DirectoryDownloadCompletion extends DirectoryDownloadProgress {
  size: number;
}

export interface BinaryDownloadSink {
  readonly position: number;
  write(chunk: Uint8Array): Promise<void>;
  complete(): Promise<DownloadArtifact>;
  /** 目录归档断线后原地截断；不支持时调用方会销毁并重建 sink。 */
  reset?(): Promise<void>;
  discard(): Promise<void>;
}

export interface BinaryFileDownloadOptions {
  kind?: "file" | "directory";
  path: string;
  fileName: string;
  createSocket: (signal?: AbortSignal) => Promise<WebSocket>;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number | null) => void;
  onArchiveProgress?: (progress: DirectoryDownloadProgress) => void;
  onRetry?: (error: unknown, attempt: number, maxRetries: number) => void | Promise<void>;
  idleTimeoutMs?: number;
  maxTransientRetries?: number;
  /** 测试或特殊宿主注入；生产默认优先 OPFS，缺失时使用有上限的内存 sink。 */
  createSink?: (size: number | null) => Promise<BinaryDownloadSink>;
  /** Native sink 已写入用户选择的位置时，禁止再次触发浏览器 Blob 下载。 */
  saveArtifact?: boolean;
  now?: () => number;
}

interface FileIdentity {
  size: number;
  mtime: number;
  identity: string;
}

interface DownloadSession {
  sink: BinaryDownloadSink | null;
  identity: FileIdentity | null;
  archive: DirectoryDownloadCompletion | null;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("下载已取消", "AbortError");
}

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function connectionLost(message: string): BinaryFileDownloadError {
  return new BinaryFileDownloadError("FILE_DOWNLOAD_CONNECTION_LOST", message);
}

function waitForSocket(
  createSocket: (signal?: AbortSignal) => Promise<WebSocket>,
  deadline: number,
  now: () => number,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
): Promise<WebSocket> {
  const remaining = Math.ceil(deadline - now());
  if (remaining <= 0) return Promise.reject(new FileDownloadStalledError(idleTimeoutMs));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    const timer = setTimeout(
      () => finish(() => reject(new FileDownloadStalledError(idleTimeoutMs))),
      remaining,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    void createSocket(signal).then(
      (socket) => {
        if (settled) {
          if (socket.readyState !== WS_CLOSED && socket.readyState !== WS_CLOSING) socket.close();
          return;
        }
        finish(() => resolve(socket));
      },
      (error) =>
        finish(() =>
          reject(
            error instanceof BinaryFileDownloadError
              ? error
              : connectionLost(error instanceof Error ? error.message : String(error)),
          ),
        ),
    );
  });
}

function waitWithinDeadline(
  operation: () => void | Promise<void>,
  deadline: number,
  now: () => number,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
): Promise<void> {
  const remaining = Math.ceil(deadline - now());
  if (remaining <= 0) return Promise.reject(new FileDownloadStalledError(idleTimeoutMs));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    const timer = setTimeout(
      () => finish(() => reject(new FileDownloadStalledError(idleTimeoutMs))),
      remaining,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    void Promise.resolve()
      .then(operation)
      .then(
        () => finish(resolve),
        (error) => finish(() => reject(error)),
      );
  });
}

async function receiveAttempt(options: {
  socket: WebSocket;
  kind: "file" | "directory";
  path: string;
  session: DownloadSession;
  createSink: (size: number | null) => Promise<BinaryDownloadSink>;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number | null) => void;
  onArchiveProgress?: (progress: DirectoryDownloadProgress) => void;
  idleTimeoutMs: number;
  getDeadline: () => number;
  resetDeadline: () => void;
  now: () => number;
}): Promise<void> {
  const { socket, signal } = options;
  socket.binaryType = "arraybuffer";
  let sink = options.session.sink;
  let identity = options.session.identity;
  let archiveProgress: DirectoryDownloadProgress = {
    processedEntries: 0,
    sourceBytes: 0,
    skippedEntries: 0,
  };
  let ready = false;
  let completed = false;
  let settled = false;
  let stopping = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let processing = Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener("abort", onAbort);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const closeSocket = () => {
      if (socket.readyState === WS_OPEN) {
        try {
          socket.send(JSON.stringify({ type: "cancel" }));
        } catch {
          // The transport is already unusable.
        }
      }
      if (socket.readyState !== WS_CLOSED && socket.readyState !== WS_CLOSING) {
        try {
          socket.close();
        } catch {
          // The transport became unusable between the state check and close().
        }
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket();
      reject(error);
    };
    const requestFailure = (error: unknown) => {
      if (settled || stopping) return;
      stopping = true;
      closeSocket();
      void processing.then(() => fail(error));
    };
    const succeed = () => {
      if (settled || !sink || (options.kind === "file" && !identity)) return;
      settled = true;
      completed = true;
      cleanup();
      if (socket.readyState !== WS_CLOSED && socket.readyState !== WS_CLOSING)
        socket.close(1000, "download complete");
      resolve();
    };
    const armTimer = () => {
      if (timer !== null) clearTimeout(timer);
      const remaining = Math.ceil(options.getDeadline() - options.now());
      if (remaining <= 0) {
        requestFailure(new FileDownloadStalledError(options.idleTimeoutMs));
        return;
      }
      timer = setTimeout(
        () => requestFailure(new FileDownloadStalledError(options.idleTimeoutMs)),
        remaining,
      );
    };
    const onAbort = () => requestFailure(abortReason(signal));
    const onOpen = () => {
      if (settled || stopping) return;
      try {
        socket.send(
          JSON.stringify(
            options.kind === "directory"
              ? {
                  type: "open",
                  kind: "directory",
                  archiveFormat: "zip",
                  path: options.path,
                }
              : {
                  type: "open",
                  path: options.path,
                  offset: sink?.position ?? 0,
                  expectedSize: identity?.size,
                  expectedMtime: identity?.mtime,
                  expectedIdentity: identity?.identity,
                },
          ),
        );
      } catch {
        requestFailure(connectionLost("无法打开下载连接"));
      }
    };
    const handleMessage = async (event: MessageEvent): Promise<void> => {
      signal?.throwIfAborted();
      if (typeof event.data !== "string") {
        if (!ready || !sink || !(event.data instanceof ArrayBuffer))
          throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "收到无效的下载数据帧");
        const chunk = new Uint8Array(event.data);
        if (
          chunk.byteLength === 0 ||
          (options.kind === "file" &&
            (!identity || sink.position + chunk.byteLength > identity.size))
        )
          throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "下载数据长度无效");
        await sink.write(chunk);
        signal?.throwIfAborted();
        options.onProgress?.(sink.position, identity?.size ?? null);
        if (socket.readyState !== WS_OPEN) throw connectionLost("下载连接已断开");
        socket.send(JSON.stringify({ type: "ack", bytes: chunk.byteLength }));
        return;
      }

      let message;
      try {
        message = fileDownloadServerMessageSchema.parse(JSON.parse(event.data));
      } catch {
        throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "收到无效的下载控制消息");
      }
      if (message.type === "ready") {
        const messageKind = message.kind === "directory" ? "directory" : "file";
        if (ready || messageKind !== options.kind)
          throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "下载类型不一致");
        if (message.kind === "directory") {
          if (message.offset !== 0 || (sink && sink.position !== 0))
            throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "目录下载不支持续传");
          if (!sink) {
            sink = await options.createSink(null);
            options.session.sink = sink;
          }
          signal?.throwIfAborted();
          ready = true;
          options.onProgress?.(0, null);
          socket.send(JSON.stringify({ type: "start" }));
          return;
        }
        if (message.offset !== (sink?.position ?? 0))
          throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "下载续传偏移不一致");
        if (
          identity &&
          (message.size !== identity.size ||
            message.mtime !== identity.mtime ||
            message.identity !== identity.identity)
        ) {
          throw new BinaryFileDownloadError(FS_DOWNLOAD_ERROR_CHANGED, "文件在下载期间发生变化");
        }
        identity ??= { size: message.size, mtime: message.mtime, identity: message.identity };
        options.session.identity = identity;
        if (!sink) {
          sink = await options.createSink(message.size);
          options.session.sink = sink;
        }
        signal?.throwIfAborted();
        if (sink.position !== message.offset)
          throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "本地下载偏移不一致");
        ready = true;
        options.onProgress?.(sink.position, identity.size);
        socket.send(JSON.stringify({ type: "start" }));
        return;
      }
      if (message.type === "error") {
        throw new BinaryFileDownloadError(message.code, message.message);
      }
      if (message.type === "progress") {
        if (options.kind !== "directory" || !ready)
          throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "收到无效的目录打包进度");
        if (
          message.processedEntries < archiveProgress.processedEntries ||
          message.sourceBytes < archiveProgress.sourceBytes ||
          message.skippedEntries < archiveProgress.skippedEntries
        )
          throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "目录打包进度回退");
        const advanced =
          message.processedEntries > archiveProgress.processedEntries ||
          message.sourceBytes > archiveProgress.sourceBytes ||
          message.skippedEntries > archiveProgress.skippedEntries;
        archiveProgress = {
          processedEntries: message.processedEntries,
          sourceBytes: message.sourceBytes,
          skippedEntries: message.skippedEntries,
        };
        if (advanced) {
          options.resetDeadline();
          armTimer();
          options.onArchiveProgress?.(archiveProgress);
        }
        return;
      }
      if (!ready || !sink) {
        throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "下载流提前结束");
      }
      const completeKind = message.kind ?? options.kind;
      if (
        completeKind !== options.kind ||
        (message.size !== undefined && message.size !== sink.position) ||
        (options.kind === "directory" && message.size === undefined)
      )
        throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "下载完成信息不一致");
      if (options.kind === "file") {
        if (!identity || sink.position !== identity.size)
          throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "下载流提前结束");
      } else {
        if (
          message.processedEntries === undefined ||
          message.sourceBytes === undefined ||
          message.skippedEntries === undefined
        )
          throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "目录归档完成信息缺失");
        if (
          message.processedEntries < archiveProgress.processedEntries ||
          message.sourceBytes < archiveProgress.sourceBytes ||
          message.skippedEntries < archiveProgress.skippedEntries
        )
          throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "目录归档完成进度回退");
        const archive = {
          size: message.size as number,
          processedEntries: message.processedEntries,
          sourceBytes: message.sourceBytes,
          skippedEntries: message.skippedEntries,
        };
        options.session.archive = archive;
        options.onArchiveProgress?.(archive);
      }
      succeed();
    };
    const onMessage = (event: MessageEvent) => {
      if (settled || stopping) return;
      if (typeof event.data !== "string") {
        options.resetDeadline();
        armTimer();
      }
      processing = processing.then(async () => {
        // 前一条消息失败时 fail() 会立即终止本次尝试；已经排队的
        // 旧连接帧必须只排空、不再写入会被下一次重连复用的 sink。
        if (settled) return;
        try {
          await handleMessage(event);
        } catch (error) {
          fail(error);
        }
      });
    };
    const onError = () => {
      requestFailure(connectionLost("下载连接发生错误"));
    };
    const onClose = () => {
      if (completed || settled) return;
      requestFailure(connectionLost("下载连接已断开"));
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    armTimer();
    if (signal?.aborted) onAbort();
    else if (socket.readyState === WS_OPEN) onOpen();
    else if (socket.readyState === WS_CLOSING || socket.readyState === WS_CLOSED)
      requestFailure(connectionLost("下载连接已断开"));
  });
}

interface IterableFileSystemDirectoryHandle extends FileSystemDirectoryHandle {
  entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
}

interface OpfsLease {
  release(): Promise<void>;
}

function noOpLease(): OpfsLease {
  return { release: async () => {} };
}

async function acquireOpfsLease(name: string): Promise<OpfsLease> {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return noOpLease();
  let releaseHold!: () => void;
  let markAcquired!: () => void;
  let markFailed!: (error: unknown) => void;
  let entered = false;
  let released = false;
  const acquired = new Promise<void>((resolve, reject) => {
    markAcquired = resolve;
    markFailed = reject;
  });
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let completion: Promise<void>;
  try {
    completion = locks
      .request<void>(`${OPFS_LOCK_PREFIX}${name}`, async () => {
        entered = true;
        markAcquired();
        await hold;
      })
      .catch((error: unknown) => {
        if (!entered) markFailed(error);
      });
    await acquired;
  } catch {
    return noOpLease();
  }
  return {
    async release() {
      if (released) return;
      released = true;
      releaseHold();
      await completion;
    },
  };
}

async function removeStaleOpfsEntry(root: FileSystemDirectoryHandle, name: string): Promise<void> {
  if (activeOpfsEntries.has(name)) return;
  const remove = async () => {
    if (activeOpfsEntries.has(name)) return;
    await root.removeEntry(name).catch(() => {});
  };
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) {
    await remove();
    return;
  }
  await locks
    .request(`${OPFS_LOCK_PREFIX}${name}`, { ifAvailable: true }, async (lock) => {
      if (lock) await remove();
    })
    .catch(() => {});
}

async function cleanupStaleOpfsEntries(
  root: IterableFileSystemDirectoryHandle,
  now = Date.now(),
): Promise<void> {
  const entries = root.entries;
  if (!entries) return;
  try {
    for await (const [name, handle] of entries.call(root)) {
      if (!name.startsWith(OPFS_PREFIX) || handle.kind !== "file" || activeOpfsEntries.has(name))
        continue;
      let lastModified: number;
      try {
        lastModified = (await (handle as FileSystemFileHandle).getFile()).lastModified;
      } catch {
        continue;
      }
      if (!Number.isFinite(lastModified) || now - lastModified < OPFS_STALE_AFTER_MS) continue;
      await removeStaleOpfsEntry(root, name);
    }
  } catch {
    // Cleanup is best effort; inability to enumerate private storage must not block a new download.
  }
}

async function createOpfsSink(): Promise<BinaryDownloadSink | null> {
  const storage = globalThis.navigator?.storage as
    (StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> }) | undefined;
  if (!storage?.getDirectory) return null;
  const root = (await storage.getDirectory()) as IterableFileSystemDirectoryHandle;
  await cleanupStaleOpfsEntries(root);
  const name = `${OPFS_PREFIX}${Date.now().toString(36)}-${globalThis.crypto.randomUUID()}.tmp`;
  activeOpfsEntries.add(name);
  const lease = await acquireOpfsLease(name);
  let handle: FileSystemFileHandle;
  let writable: FileSystemWritableFileStream;
  try {
    handle = await root.getFileHandle(name, { create: true });
    writable = await handle.createWritable({ keepExistingData: false });
  } catch (error) {
    try {
      await root.removeEntry(name).catch(() => {});
    } finally {
      activeOpfsEntries.delete(name);
      await lease.release();
    }
    throw error;
  }
  let position = 0;
  let finished = false;
  let cleanup: Promise<void> | null = null;
  const remove = async () => {
    cleanup ??= (async () => {
      try {
        await root.removeEntry(name).catch(() => {});
      } finally {
        activeOpfsEntries.delete(name);
        await lease.release();
      }
    })();
    await cleanup;
  };
  return {
    get position() {
      return position;
    },
    async write(chunk) {
      if (finished) throw new Error("download sink is closed");
      await writable.write(new Blob([chunk as BlobPart]));
      position += chunk.byteLength;
    },
    async complete() {
      if (finished) throw new Error("download sink is closed");
      finished = true;
      await writable.close();
      const blob = await handle.getFile();
      if (blob.size !== position)
        throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "本地下载文件长度不一致");
      return { blob, size: position, dispose: remove };
    },
    async discard() {
      if (!finished) {
        finished = true;
        try {
          await writable.abort();
        } catch {
          // Ignore a concurrent browser-side close.
        }
      }
      await remove();
    },
  };
}

function createMemorySink(size: number | null): BinaryDownloadSink {
  if (size !== null && size > FILE_DOWNLOAD_MEMORY_FALLBACK_MAX_BYTES) {
    throw new BinaryFileDownloadError(
      "FILE_DOWNLOAD_LOCAL_LIMIT",
      "当前浏览器不支持磁盘流式下载，无法下载超过 128 MiB 的文件",
    );
  }
  let position = 0;
  let parts: BlobPart[] = [];
  let finished = false;
  return {
    get position() {
      return position;
    },
    async write(chunk) {
      if (finished) throw new Error("download sink is closed");
      if (position + chunk.byteLength > FILE_DOWNLOAD_MEMORY_FALLBACK_MAX_BYTES) {
        throw new BinaryFileDownloadError(
          "FILE_DOWNLOAD_LOCAL_LIMIT",
          "当前浏览器不支持磁盘流式下载，无法下载超过 128 MiB 的内容",
        );
      }
      parts.push(chunk.slice().buffer);
      position += chunk.byteLength;
    },
    async complete() {
      if (finished) throw new Error("download sink is closed");
      finished = true;
      const blob = new Blob(parts);
      parts = [];
      return { blob, size: position, dispose: async () => {} };
    },
    async discard() {
      finished = true;
      parts = [];
      position = 0;
    },
  };
}

export async function createBrowserDownloadSink(size: number | null): Promise<BinaryDownloadSink> {
  try {
    const sink = await createOpfsSink();
    if (sink) return sink;
  } catch {
    // WebView/浏览器可能暴露 OPFS API，但因配额、权限或实现不完整而无法创建
    // writable。小文件仍可安全回退；大文件由内存 sink 给出明确的本地能力错误。
  }
  return createMemorySink(size);
}

/** 接收二进制流到磁盘临时文件；文件按落盘偏移续传，目录归档失败后从零重试。 */
export async function receiveBinaryFileDownload(
  options: Omit<BinaryFileDownloadOptions, "fileName">,
): Promise<DownloadArtifact> {
  const kind = options.kind ?? "file";
  const idleTimeoutMs = options.idleTimeoutMs ?? FILE_DOWNLOAD_IDLE_TIMEOUT_MS;
  const maxRetries = options.maxTransientRetries ?? FILE_DOWNLOAD_MAX_TRANSIENT_RETRIES;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) throw new Error("无效的下载停滞期限");
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error("无效的下载重试次数");
  const now = options.now ?? (() => performance.now());
  const createSink = options.createSink ?? createBrowserDownloadSink;
  let deadline = now() + idleTimeoutMs;
  const session: DownloadSession = { sink: null, identity: null, archive: null };
  let retries = 0;

  try {
    for (;;) {
      options.signal?.throwIfAborted();
      let socket: WebSocket;
      try {
        socket = await waitForSocket(
          options.createSocket,
          deadline,
          now,
          options.signal,
          idleTimeoutMs,
        );
        await receiveAttempt({
          socket,
          kind,
          path: options.path,
          session,
          createSink,
          signal: options.signal,
          onProgress: options.onProgress,
          onArchiveProgress: options.onArchiveProgress,
          idleTimeoutMs,
          getDeadline: () => deadline,
          resetDeadline: () => {
            deadline = now() + idleTimeoutMs;
          },
          now,
        });
        if (
          !session.sink ||
          (kind === "file" && !session.identity) ||
          (kind === "directory" && !session.archive)
        )
          throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "下载未返回完整信息");
        options.signal?.throwIfAborted();
        const artifact = await session.sink.complete();
        if (options.signal?.aborted) {
          await artifact.dispose();
          throw abortReason(options.signal);
        }
        return session.archive ? { ...artifact, archive: session.archive } : artifact;
      } catch (error) {
        if (options.signal?.aborted) throw abortReason(options.signal);
        if (now() >= deadline) throw new FileDownloadStalledError(idleTimeoutMs);
        if (!RETRYABLE_CODES.has(errorCode(error) ?? "") || retries >= maxRetries) throw error;
        if (kind === "directory" && session.sink) {
          if (session.sink.reset) {
            await session.sink.reset();
            if (session.sink.position !== 0)
              throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "目录下载目标未能重置");
          } else {
            await session.sink.discard();
            session.sink = null;
          }
          session.identity = null;
          session.archive = null;
        }
        retries += 1;
        await waitWithinDeadline(
          () => options.onRetry?.(error, retries, maxRetries),
          deadline,
          now,
          options.signal,
          idleTimeoutMs,
        );
      }
    }
  } catch (error) {
    await session.sink?.discard();
    throw error;
  }
}

/** 交给浏览器/Tauri 下载管理器保存；OPFS 临时文件在 Blob URL 释放后清理。 */
export function saveDownloadArtifact(
  fileName: string,
  artifact: DownloadArtifact,
  mimeType = "application/octet-stream",
): void {
  // 空 MIME 会被 Chromium 当作 text/plain，给无扩展名文件追加 .txt。
  // 只声明二进制下载类型，不读取或重新编码文件内容，保留原始文件名。
  const downloadBlob = artifact.blob.slice(0, artifact.blob.size, mimeType);
  const url = URL.createObjectURL(downloadBlob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  setTimeout(() => {
    URL.revokeObjectURL(url);
    void artifact.dispose();
  }, 10 * 60_000);
}

export async function downloadBinaryFile(options: BinaryFileDownloadOptions): Promise<number> {
  const artifact = await receiveBinaryFileDownload({ ...options, kind: "file" });
  try {
    options.signal?.throwIfAborted();
    if (options.saveArtifact !== false) {
      saveDownloadArtifact(options.fileName, artifact);
    } else {
      await artifact.dispose();
    }
  } catch (error) {
    await artifact.dispose();
    throw error;
  }
  return artifact.size;
}

export async function downloadBinaryDirectory(
  options: BinaryFileDownloadOptions,
): Promise<DirectoryDownloadCompletion> {
  const artifact = await receiveBinaryFileDownload({ ...options, kind: "directory" });
  try {
    options.signal?.throwIfAborted();
    if (!artifact.archive)
      throw new BinaryFileDownloadError("FILE_DOWNLOAD_INVALID", "目录归档完成信息缺失");
    if (options.saveArtifact !== false) {
      saveDownloadArtifact(options.fileName, artifact, "application/zip");
    } else {
      await artifact.dispose();
    }
    return artifact.archive;
  } catch (error) {
    await artifact.dispose();
    throw error;
  }
}
