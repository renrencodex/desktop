/**
 * fs.* RPC 封装（12.1 fs namespace）：
 * 经 MachineRpcClient 调 agentd 的普通 fs 方法；上传与编辑器整文件读取按
 * FS_MAX_CHUNK_BYTES 分块。下载使用独立 binary-file-download 通道。
 */
import {
  CMP_METHODS,
  FS_MAX_CHUNK_BYTES,
  FS_TEXT_MAX_BYTES,
  fsListResultSchema,
  fsReadResultSchema,
  fsStatResultSchema,
  fsWriteResultSchema,
  type FsEntry,
  type FsReadResult,
  type FsStatResult,
} from "@cloud-machine/client-contracts";

import { base64ToBytes, bytesToBase64 } from "./base64";
import type { MachineRpcClient } from "./machine-rpc";

export async function statFile(
  rpc: MachineRpcClient,
  path: string,
  signal?: AbortSignal,
): Promise<FsStatResult> {
  return fsStatResultSchema.parse(await rpc.call(CMP_METHODS.FS_STAT, { path }, { signal }));
}

/** Save a captured editor buffer. A failed multi-chunk save never truncates its destination. */
export async function saveTextFile(
  rpc: MachineRpcClient,
  path: string,
  value: string,
  savedContent: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > FS_TEXT_MAX_BYTES)
    throw new Error("文件内容超过 5 MiB 编辑上限，请缩小内容后保存；未保存修改已保留");
  const readText = async () =>
    new TextDecoder().decode(await readFileAll(rpc, path, { maxBytes: FS_TEXT_MAX_BYTES }));
  const remote = await readText();
  // Retry after a lost commit acknowledgement without a false conflict or second write.
  if (remote === value) return;
  if (remote !== savedContent)
    throw new Error("文件已在远端修改。请复制本地修改并重新打开文件核对后保存");
  if (bytes.length <= FS_MAX_CHUNK_BYTES) {
    await writeFileAll(rpc, path, bytes);
    return;
  }
  await writeBlobAtomically(rpc, path, new Blob([bytes]), {
    beforeCommit: async () => {
      if ((await readText()) !== savedContent)
        throw new Error("文件已在远端修改，已停止保存并保留本地内容");
    },
  });
}

export async function listDir(rpc: MachineRpcClient, path: string): Promise<FsEntry[]> {
  const result = fsListResultSchema.parse(await rpc.call(CMP_METHODS.FS_LIST, { path }));
  return result.entries;
}

export class FileReadLimitError extends Error {
  constructor(
    public readonly size: number,
    public readonly limit: number,
  ) {
    super("文件超过读取上限");
    this.name = "FileReadLimitError";
  }
}

interface CollectFileOptions {
  maxBytes?: number;
  signal?: AbortSignal;
}

async function collectFile(
  read: (offset: number) => Promise<FsReadResult>,
  options: CollectFileOptions,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let expectedSize: number | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const result = await read(offset);
    options.signal?.throwIfAborted();
    if (options.maxBytes !== undefined && result.totalSize > options.maxBytes) {
      throw new FileReadLimitError(result.totalSize, options.maxBytes);
    }
    if (expectedSize !== undefined && expectedSize !== result.totalSize) {
      throw new Error("文件在读取期间发生变化，请重新加载");
    }
    expectedSize = result.totalSize;
    const chunk = base64ToBytes(result.data);
    if (options.maxBytes !== undefined && offset + chunk.length > options.maxBytes) {
      throw new FileReadLimitError(offset + chunk.length, options.maxBytes);
    }
    if (
      (!result.eof && chunk.length === 0) ||
      offset + chunk.length > result.totalSize ||
      result.eof !== (offset + chunk.length === result.totalSize)
    ) {
      throw new Error("文件读取响应不完整，请重新加载");
    }
    parts.push(chunk);
    offset += chunk.length;
    if (result.eof) break;
  }
  const out = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** 分块读完整文件；取消不关闭其他编辑器共享的 RPC 连接。 */
export async function readFileAll(
  rpc: MachineRpcClient,
  path: string,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  if (
    options.maxBytes !== undefined &&
    (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
  ) {
    throw new Error("无效的文件读取上限");
  }
  return collectFile(
    async (offset) =>
      fsReadResultSchema.parse(
        await rpc.call(
          CMP_METHODS.FS_READ,
          { path, offset, length: FS_MAX_CHUNK_BYTES },
          { signal: options.signal },
        ),
      ),
    options,
  );
}

/**
 * 分块写完整内容：首块 truncate（原子覆盖），后续块 offset 追加。
 * onProgress(written, total) 供上传/保存进度提示。
 */
export async function writeFileAll(
  rpc: MachineRpcClient,
  path: string,
  data: Uint8Array,
  onProgress?: (written: number, total: number) => void,
): Promise<void> {
  let offset = 0;
  do {
    const chunk = data.subarray(offset, offset + FS_MAX_CHUNK_BYTES);
    const res = fsWriteResultSchema.parse(
      await rpc.call(CMP_METHODS.FS_WRITE, {
        path,
        data: bytesToBase64(chunk),
        ...(offset === 0 ? { truncate: true } : { offset }),
      }),
    );
    offset += res.bytesWritten;
    onProgress?.(offset, data.length);
    // 空文件：首块 truncate 写 0 字节即完成
  } while (offset < data.length);
}

export interface BlobWriteOptions {
  signal?: AbortSignal;
  onProgress?: (written: number, total: number) => void;
  beforeCommit?: () => void | Promise<void>;
  /** Deterministic injection for tests; production uses crypto.randomUUID(). */
  randomId?: () => string;
}

/** Stream a browser Blob to a sibling temporary file, then atomically replace the destination. */
export async function writeBlobAtomically(
  rpc: MachineRpcClient,
  path: string,
  blob: Blob,
  options: BlobWriteOptions = {},
): Promise<void> {
  if (!path.startsWith("/") || path.endsWith("/")) throw new Error("无效的上传目标路径");
  const slash = path.lastIndexOf("/");
  const parent = slash === 0 ? "/" : path.slice(0, slash);
  const id = options.randomId?.() ?? globalThis.crypto.randomUUID();
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("无效的上传临时标识");
  const temporary = `${parent === "/" ? "" : parent}/.cm-upload-${id}.tmp`;
  let committed = false;
  let offset = 0;

  try {
    do {
      options.signal?.throwIfAborted();
      const chunk = new Uint8Array(
        await blob.slice(offset, offset + FS_MAX_CHUNK_BYTES).arrayBuffer(),
      );
      options.signal?.throwIfAborted();
      const result = fsWriteResultSchema.parse(
        await rpc.call(CMP_METHODS.FS_WRITE, {
          path: temporary,
          data: bytesToBase64(chunk),
          ...(offset === 0 ? { truncate: true } : { offset }),
        }),
      );
      options.signal?.throwIfAborted();
      if (result.bytesWritten !== chunk.length) throw new Error("文件上传响应不完整");
      offset += result.bytesWritten;
      options.onProgress?.(offset, blob.size);
    } while (offset < blob.size);

    await options.beforeCommit?.();
    options.signal?.throwIfAborted();
    await rename(rpc, temporary, path, true);
    committed = true;
  } finally {
    if (!committed) {
      try {
        await remove(rpc, temporary, false);
      } catch {
        // The first write may not have created the temporary file, or the rename acknowledgement
        // may have been lost after committing it. Cleanup is deliberately best-effort.
      }
    }
  }
}

export async function mkdir(rpc: MachineRpcClient, path: string): Promise<void> {
  await rpc.call(CMP_METHODS.FS_MKDIR, { path, recursive: true });
}

export async function rename(
  rpc: MachineRpcClient,
  from: string,
  to: string,
  overwrite = false,
): Promise<void> {
  await rpc.call(CMP_METHODS.FS_RENAME, { from, to, overwrite });
}

export async function remove(
  rpc: MachineRpcClient,
  path: string,
  recursive: boolean,
): Promise<void> {
  await rpc.call(CMP_METHODS.FS_REMOVE, { path, recursive });
}
