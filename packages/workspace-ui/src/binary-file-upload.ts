import {
  FILE_UPLOAD_PROTOCOL_VERSION,
  FS_UPLOAD_BINARY_HEADER_BYTES,
  FS_UPLOAD_BINARY_MAGIC,
  FS_UPLOAD_BINARY_VERSION,
  FS_UPLOAD_CHUNK_BYTES,
  FS_UPLOAD_CLIENT_MAX_CONCURRENT,
  FS_UPLOAD_IDLE_TIMEOUT_MS,
  FS_UPLOAD_WINDOW_BYTES,
  fileUploadServerMessageSchema,
  type FileUploadServerMessage,
} from "@cloud-machine/client-contracts";

const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;
const OPEN_TIMEOUT_MS = 15_000;

export class BinaryFileUploadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BinaryFileUploadError";
  }
}

export interface BinaryFileUploadOptions {
  path: string;
  blob: Blob;
  signal?: AbortSignal;
  beforeCommit?: () => void | Promise<void>;
  onProgress?: (written: number, total: number) => void;
}

export interface OpenBinaryFileUploadSessionOptions {
  createSocket: (signal?: AbortSignal) => Promise<WebSocket>;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  openTimeoutMs?: number;
}

interface Transfer {
  id: string;
  options: BinaryFileUploadOptions;
  sent: number;
  acknowledged: number;
  ready: boolean;
  finishSent: boolean;
  staged: boolean;
  commitSent: boolean;
  terminal: boolean;
  pumping: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  abort: (() => void) | null;
  resolve: (size: number) => void;
  reject: (error: unknown) => void;
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException("上传已取消", "AbortError");
}

function connectionLost(message: string): BinaryFileUploadError {
  return new BinaryFileUploadError("FILE_UPLOAD_CONNECTION_LOST", message);
}

function invalid(message: string): BinaryFileUploadError {
  return new BinaryFileUploadError("FILE_UPLOAD_INVALID", message);
}

function uuidBytes(value: string): Uint8Array {
  const compact = value.replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(compact)) throw invalid("无法生成上传传输标识");
  const result = new Uint8Array(16);
  for (let index = 0; index < result.length; index += 1)
    result[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  return result;
}

export function fileUploadFrame(transferId: string, payload: Uint8Array): ArrayBuffer {
  if (payload.byteLength === 0 || payload.byteLength > FS_UPLOAD_CHUNK_BYTES)
    throw invalid("上传数据块大小无效");
  const frame = new Uint8Array(FS_UPLOAD_BINARY_HEADER_BYTES + payload.byteLength);
  frame.set(new TextEncoder().encode(FS_UPLOAD_BINARY_MAGIC), 0);
  frame[4] = FS_UPLOAD_BINARY_VERSION;
  frame.set(uuidBytes(transferId), 5);
  frame.set(payload, FS_UPLOAD_BINARY_HEADER_BYTES);
  return frame.buffer;
}

/** 一个连接承载一批文件，调用方最多并行发起服务端 hello 声明的文件数。 */
export class BinaryFileUploadSession {
  private readonly transfers = new Map<string, Transfer>();
  private readonly ignoredTransfers = new Set<string>();
  private closed = false;
  private hello: Extract<FileUploadServerMessage, { type: "hello" }> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private helloResolve: (() => void) | null = null;
  private helloReject: ((error: unknown) => void) | null = null;
  private readonly ready: Promise<void>;

  private constructor(
    private readonly socket: WebSocket,
    private readonly signal: AbortSignal | undefined,
    private readonly idleTimeoutMs: number,
    openTimeoutMs: number,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
    });
    this.helloTimer = setTimeout(
      () => this.failChannel(new BinaryFileUploadError("FILE_UPLOAD_STALLED", "上传通道握手超时")),
      openTimeoutMs,
    );
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", this.onMessage);
    socket.addEventListener("error", this.onError);
    socket.addEventListener("close", this.onClose);
    signal?.addEventListener("abort", this.onSessionAbort, { once: true });
    if (signal?.aborted) this.onSessionAbort();
    else if (socket.readyState === WS_CLOSING || socket.readyState === WS_CLOSED)
      this.failChannel(connectionLost("上传通道已断开"));
  }

  static async open(options: OpenBinaryFileUploadSessionOptions): Promise<BinaryFileUploadSession> {
    options.signal?.throwIfAborted();
    const socket = await options.createSocket(options.signal);
    const session = new BinaryFileUploadSession(
      socket,
      options.signal,
      options.idleTimeoutMs ?? FS_UPLOAD_IDLE_TIMEOUT_MS,
      options.openTimeoutMs ?? OPEN_TIMEOUT_MS,
    );
    try {
      await session.ready;
      return session;
    } catch (error) {
      session.closeSocket();
      throw error;
    }
  }

  async upload(options: BinaryFileUploadOptions): Promise<number> {
    await this.ready;
    if (this.closed || this.socket.readyState !== WS_OPEN) throw connectionLost("上传通道已断开");
    options.signal?.throwIfAborted();
    if (!Number.isSafeInteger(options.blob.size) || options.blob.size < 0)
      throw invalid("本地文件大小超出上传协议范围");
    const maxConcurrent = this.hello?.maxConcurrent ?? FS_UPLOAD_CLIENT_MAX_CONCURRENT;
    if (this.transfers.size >= maxConcurrent)
      throw new BinaryFileUploadError("FILE_UPLOAD_LIMIT_REACHED", "上传并发数量已达到上限");
    const id = crypto.randomUUID();
    return new Promise<number>((resolve, reject) => {
      const transfer: Transfer = {
        id,
        options,
        sent: 0,
        acknowledged: 0,
        ready: false,
        finishSent: false,
        staged: false,
        commitSent: false,
        terminal: false,
        pumping: false,
        timer: null,
        abort: null,
        resolve,
        reject,
      };
      const onAbort = () => this.cancelTransfer(transfer, abortReason(options.signal));
      transfer.abort = onAbort;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.transfers.set(id, transfer);
      this.armIdle(transfer);
      try {
        this.sendJson({
          type: "open",
          transferId: id,
          path: options.path,
          size: options.blob.size,
        });
      } catch (error) {
        this.failChannel(error);
      }
    });
  }

  close(reason: unknown = new DOMException("上传通道已关闭", "AbortError")): void {
    if (this.closed) return;
    for (const transfer of [...this.transfers.values()]) this.cancelTransfer(transfer, reason);
    this.closed = true;
    this.helloReject?.(reason);
    this.helloResolve = null;
    this.helloReject = null;
    this.cleanupSocket();
    this.closeSocket();
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (this.closed) return;
    if (typeof event.data !== "string") {
      this.failChannel(invalid("上传服务端返回了意外的二进制消息"));
      return;
    }
    let message: FileUploadServerMessage;
    try {
      message = fileUploadServerMessageSchema.parse(JSON.parse(event.data));
    } catch {
      this.failChannel(invalid("收到无效的上传控制消息"));
      return;
    }
    if (message.type === "hello") {
      if (
        this.hello ||
        message.protocolVersion !== FILE_UPLOAD_PROTOCOL_VERSION ||
        message.chunkBytes !== FS_UPLOAD_CHUNK_BYTES ||
        message.windowBytes !== FS_UPLOAD_WINDOW_BYTES
      ) {
        this.failChannel(invalid("上传通道协商参数不匹配"));
        return;
      }
      this.hello = message;
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = null;
      this.helloResolve?.();
      this.helloResolve = null;
      this.helloReject = null;
      return;
    }
    if (message.type === "error") {
      this.failChannel(new BinaryFileUploadError(message.code, message.message));
      return;
    }
    if (!this.hello) {
      this.failChannel(invalid("上传通道尚未完成协商"));
      return;
    }
    const transfer = this.transfers.get(message.transferId);
    if (!transfer) {
      if (this.ignoredTransfers.has(message.transferId)) return;
      this.failChannel(invalid("上传响应不属于活动文件"));
      return;
    }
    this.handleTransferMessage(transfer, message);
  };

  private handleTransferMessage(
    transfer: Transfer,
    message: Exclude<FileUploadServerMessage, { type: "hello" | "error" }>,
  ): void {
    if (message.type === "fileError") {
      this.finishTransfer(transfer, new BinaryFileUploadError(message.code, message.message));
      return;
    }
    if (message.type === "ready") {
      if (transfer.ready) {
        this.failChannel(invalid("重复的上传 ready 消息"));
        return;
      }
      transfer.ready = true;
      this.armIdle(transfer);
      transfer.options.onProgress?.(0, transfer.options.blob.size);
      void this.pump(transfer);
      return;
    }
    if (message.type === "ack") {
      if (
        !transfer.ready ||
        transfer.staged ||
        transfer.acknowledged + message.bytes > transfer.sent
      ) {
        this.failChannel(invalid("上传确认字节数无效"));
        return;
      }
      transfer.acknowledged += message.bytes;
      this.armIdle(transfer);
      transfer.options.onProgress?.(transfer.acknowledged, transfer.options.blob.size);
      this.maybeFinish(transfer);
      void this.pump(transfer);
      return;
    }
    if (message.type === "staged") {
      if (
        !transfer.finishSent ||
        transfer.staged ||
        transfer.acknowledged !== transfer.options.blob.size
      ) {
        this.failChannel(invalid("上传暂存状态无效"));
        return;
      }
      transfer.staged = true;
      this.armIdle(transfer);
      void Promise.resolve()
        .then(transfer.options.beforeCommit)
        .then(() => {
          if (transfer.terminal) return;
          transfer.options.signal?.throwIfAborted();
          transfer.commitSent = true;
          this.sendJson({ type: "commit", transferId: transfer.id });
          this.armIdle(transfer);
        })
        .catch((error: unknown) => this.cancelTransfer(transfer, error));
      return;
    }
    if (!transfer.staged || !transfer.commitSent) {
      this.failChannel(invalid("上传文件在提交前完成"));
      return;
    }
    transfer.options.onProgress?.(transfer.options.blob.size, transfer.options.blob.size);
    this.finishTransfer(transfer, null);
  }

  private async pump(transfer: Transfer): Promise<void> {
    if (transfer.pumping || transfer.terminal || !transfer.ready || transfer.staged) return;
    transfer.pumping = true;
    try {
      while (!transfer.terminal && transfer.sent < transfer.options.blob.size) {
        transfer.options.signal?.throwIfAborted();
        const windowBytes = this.hello?.windowBytes ?? FS_UPLOAD_WINDOW_BYTES;
        const chunkBytes = this.hello?.chunkBytes ?? FS_UPLOAD_CHUNK_BYTES;
        const available = windowBytes - (transfer.sent - transfer.acknowledged);
        if (available <= 0) break;
        const end = Math.min(
          transfer.options.blob.size,
          transfer.sent + chunkBytes,
          transfer.sent + available,
        );
        const payload = new Uint8Array(
          await transfer.options.blob.slice(transfer.sent, end).arrayBuffer(),
        );
        if (transfer.terminal) return;
        transfer.options.signal?.throwIfAborted();
        if (payload.byteLength !== end - transfer.sent) throw invalid("读取本地文件数据不完整");
        transfer.sent = end;
        this.socket.send(fileUploadFrame(transfer.id, payload));
        this.armIdle(transfer);
      }
      this.maybeFinish(transfer);
    } catch (error) {
      this.cancelTransfer(transfer, error);
    } finally {
      transfer.pumping = false;
    }
  }

  private maybeFinish(transfer: Transfer): void {
    if (
      transfer.terminal ||
      transfer.finishSent ||
      transfer.sent !== transfer.options.blob.size ||
      transfer.acknowledged !== transfer.options.blob.size
    )
      return;
    try {
      transfer.finishSent = true;
      this.sendJson({ type: "finish", transferId: transfer.id });
      this.armIdle(transfer);
    } catch (error) {
      this.cancelTransfer(transfer, error);
    }
  }

  private cancelTransfer(transfer: Transfer, reason: unknown): void {
    if (transfer.terminal) return;
    if (this.socket.readyState === WS_OPEN) {
      try {
        this.sendJson({ type: "cancel", transferId: transfer.id });
      } catch {
        // finishTransfer below reports the original, more useful reason.
      }
    }
    this.ignoredTransfers.add(transfer.id);
    this.finishTransfer(transfer, reason);
  }

  private finishTransfer(transfer: Transfer, error: unknown | null): void {
    if (transfer.terminal) return;
    transfer.terminal = true;
    if (transfer.timer) clearTimeout(transfer.timer);
    transfer.timer = null;
    if (transfer.abort) transfer.options.signal?.removeEventListener("abort", transfer.abort);
    this.transfers.delete(transfer.id);
    if (error === null) transfer.resolve(transfer.options.blob.size);
    else transfer.reject(error);
  }

  private armIdle(transfer: Transfer): void {
    if (transfer.terminal) return;
    if (transfer.timer) clearTimeout(transfer.timer);
    transfer.timer = setTimeout(
      () =>
        this.cancelTransfer(
          transfer,
          new BinaryFileUploadError(
            "FILE_UPLOAD_STALLED",
            `连续 ${Math.round(this.idleTimeoutMs / 1000)} 秒没有上传进度`,
          ),
        ),
      this.idleTimeoutMs,
    );
  }

  private sendJson(message: Record<string, unknown>): void {
    if (this.closed || this.socket.readyState !== WS_OPEN) throw connectionLost("上传通道已断开");
    this.socket.send(JSON.stringify(message));
  }

  private readonly onError = (): void => this.failChannel(connectionLost("上传通道发生错误"));
  private readonly onClose = (): void => this.failChannel(connectionLost("上传通道已断开"));
  private readonly onSessionAbort = (): void => this.close(abortReason(this.signal));

  private failChannel(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.helloReject?.(error);
    this.helloResolve = null;
    this.helloReject = null;
    for (const transfer of [...this.transfers.values()]) this.finishTransfer(transfer, error);
    this.cleanupSocket();
    this.closeSocket();
  }

  private cleanupSocket(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.signal?.removeEventListener("abort", this.onSessionAbort);
    this.socket.removeEventListener("message", this.onMessage);
    this.socket.removeEventListener("error", this.onError);
    this.socket.removeEventListener("close", this.onClose);
  }

  private closeSocket(): void {
    if (this.socket.readyState !== WS_CLOSED && this.socket.readyState !== WS_CLOSING) {
      try {
        this.socket.close();
      } catch {
        // Already unusable.
      }
    }
  }
}

export function openBinaryFileUploadSession(
  options: OpenBinaryFileUploadSessionOptions,
): Promise<BinaryFileUploadSession> {
  return BinaryFileUploadSession.open(options);
}
