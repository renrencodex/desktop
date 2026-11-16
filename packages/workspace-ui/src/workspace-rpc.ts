import {
  CMP_METHODS,
  FS_MAX_CHUNK_BYTES,
  fsListResultSchema,
  fsReadResultSchema,
  fsWriteResultSchema,
  type FsEntry,
} from "@cloud-machine/client-contracts";

export type WorkspaceRpcState = "idle" | "connecting" | "connected" | "disconnected" | "error";

export class WorkspaceRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceRpcError";
  }
}

interface RpcReply {
  id: string | null;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string };
}

export class WorkspaceRpcClient {
  private socket: WebSocket | null = null;
  private sequence = 0;
  private generation = 0;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: WorkspaceRpcError) => void }
  >();

  constructor(
    private readonly options: {
      machineId: string;
      gatewayWsUrl: string;
      getTicket: () => Promise<string>;
      onStateChange?: (state: WorkspaceRpcState, message?: string) => void;
    },
  ) {}

  async connect(): Promise<void> {
    this.close();
    const generation = ++this.generation;
    this.options.onStateChange?.("connecting");
    const ticket = await this.options.getTicket();
    if (generation !== this.generation) throw new WorkspaceRpcError("RPC_CLOSED", "连接已取消");
    const socket = new WebSocket(
      `${this.options.gatewayWsUrl.replace(/\/$/, "")}/machines/${encodeURIComponent(this.options.machineId)}/rpc?ticket=${encodeURIComponent(ticket)}`,
    );
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => {
        if (this.socket !== socket || generation !== this.generation) {
          reject(new WorkspaceRpcError("RPC_CLOSED", "连接已被替换"));
          return;
        }
        this.options.onStateChange?.("connected");
        resolve();
      };
      socket.onerror = () => {
        this.options.onStateChange?.("error", "电脑通道连接失败");
        reject(new WorkspaceRpcError("CONNECT_FAILED", "电脑通道连接失败"));
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.options.onStateChange?.("disconnected", "电脑通道已断开");
        this.rejectAll(new WorkspaceRpcError("RPC_CLOSED", "电脑通道已断开"));
      };
    });
    socket.onmessage = (event: MessageEvent<string>) => {
      let message: RpcReply;
      try {
        message = JSON.parse(event.data) as RpcReply;
      } catch {
        return;
      }
      if (message.id === null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else
        pending.reject(
          new WorkspaceRpcError(
            message.error?.code ?? "RPC_ERROR",
            message.error?.message ?? "远程操作失败",
          ),
        );
    };
  }

  call<T>(method: string, params?: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new WorkspaceRpcError("RPC_CLOSED", "电脑通道尚未连接"));
    }
    const id = `desktop-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new WorkspaceRpcError("RPC_TIMEOUT", "远程操作超时"));
      }, 15_000);
      this.pending.set(id, {
        resolve: (value) => {
          window.clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.rejectAll(new WorkspaceRpcError("RPC_CLOSED", "电脑通道已关闭"));
    this.options.onStateChange?.("idle");
  }

  private rejectAll(error: WorkspaceRpcError): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export async function listWorkspaceDirectory(
  rpc: WorkspaceRpcClient,
  path: string,
): Promise<FsEntry[]> {
  return fsListResultSchema.parse(await rpc.call(CMP_METHODS.FS_LIST, { path })).entries;
}

export async function readWorkspaceFile(rpc: WorkspaceRpcClient, path: string): Promise<string> {
  const result = fsReadResultSchema.parse(
    await rpc.call(CMP_METHODS.FS_READ, {
      path,
      offset: 0,
      length: FS_MAX_CHUNK_BYTES,
    }),
  );
  if (result.totalSize > FS_MAX_CHUNK_BYTES) {
    throw new Error(`文件超过 ${FS_MAX_CHUNK_BYTES} 字节原子编辑上限，无法编辑`);
  }
  const data = decodeBase64(result.data);
  if (!result.eof || data.length !== result.totalSize) {
    throw new Error("文件读取响应不完整，无法安全编辑");
  }
  return decodeWorkspaceText(data);
}

export function decodeWorkspaceText(data: Uint8Array): string {
  if (data.includes(0)) throw new Error("文件包含二进制内容，无法编辑");
  let suspiciousControls = 0;
  for (const byte of data) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) suspiciousControls++;
  }
  if (data.length > 0 && suspiciousControls / data.length > 0.1) {
    throw new Error("文件包含二进制内容，无法编辑");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("文件不是有效的 UTF-8 文本，无法编辑");
  }
}

export async function writeWorkspaceFile(
  rpc: WorkspaceRpcClient,
  path: string,
  value: string,
): Promise<void> {
  const data = new TextEncoder().encode(value);
  if (data.length > FS_MAX_CHUNK_BYTES) {
    throw new Error(`文件超过 ${FS_MAX_CHUNK_BYTES} 字节原子保存上限，拒绝保存`);
  }
  const result = fsWriteResultSchema.parse(
    await rpc.call(CMP_METHODS.FS_WRITE, {
      path,
      data: encodeBase64(data),
      truncate: true,
    }),
  );
  if (result.bytesWritten !== data.length) {
    throw new Error("文件写入不完整，保存状态未知");
  }
}
