/**
 * machine-gateway 客户端 RPC 通道（Phase 3 切片 2，13 节）：
 * WS /gateway/machines/:id/rpc?ticket=<one-time ticket>，逐条 JSON
 * → {id, method, params} ← {id, ok:true, result} | {id, ok:false, error:{code,message}}。
 *
 * - 每次连接前经 API 获取绑定 rpc 通道的一次性票据；
 * - 按 id 匹配 response（无乱序假设要求，逐条等待亦可并发）；
 * - call 默认 15s 超时（RPC_TIMEOUT）；断开/close 后 in-flight 请求全部 reject
 *   （code RPC_CLOSED），close() 会把 connState 复位为 idle，UI 显示断开提示可手动重连；
 * - gateway 侧 method 白名单为精确枚举（fs.* + system.info/metrics），
 *   其余 METHOD_NOT_ALLOWED。
 */

import { gatewayWebSocketUrl } from "../host";

export type RpcConnState = "idle" | "connecting" | "connected" | "disconnected" | "error";

export class MachineRpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MachineRpcError";
    this.code = code;
  }
}

interface ServerReply {
  id: string | null;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface MachineRpcClientOptions {
  machineId: string;
  /** 连接前取一次性票据（测试可注入）。 */
  getTicket: () => Promise<string | null>;
  onStateChange?: (state: RpcConnState, notice?: string) => void;
}

export interface MachineRpcCallOptions {
  timeoutMs?: number;
  /** 取消当前请求，但不关闭其他调用共享的 RPC 连接。 */
  signal?: AbortSignal;
}

export class MachineRpcClient {
  private readonly options: MachineRpcClientOptions;
  private ws: WebSocket | null = null;
  private seq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private state: RpcConnState = "idle";
  private connectionGeneration = 0;

  constructor(options: MachineRpcClientOptions) {
    this.options = options;
  }

  get connState(): RpcConnState {
    return this.state;
  }

  private setState(state: RpcConnState, notice?: string): void {
    this.state = state;
    this.options.onStateChange?.(state, notice);
  }

  /** 建立连接（已有连接先关闭）。 */
  async connect(): Promise<void> {
    this.close();
    const generation = ++this.connectionGeneration;
    this.setState("connecting");
    let ticket: string | null;
    try {
      ticket = await this.options.getTicket();
    } catch (error) {
      // 旧连接在取票期间被关闭/替换时，不得覆盖新连接的状态。
      if (generation !== this.connectionGeneration || this.state !== "connecting") {
        throw new MachineRpcError("RPC_CLOSED", "rpc channel closed during ticket request");
      }
      this.setState("error", "获取连接票据失败，正在自动重试…");
      throw error;
    }
    // await 期间被 close()（组件卸载/切换电脑）：放弃本次连接，避免孤儿 WS。
    if (generation !== this.connectionGeneration || this.state !== "connecting") {
      throw new MachineRpcError("RPC_CLOSED", "rpc channel closed during connect");
    }
    if (!ticket) {
      this.setState("error", "会话已过期，请重新登录");
      throw new MachineRpcError("UNAUTHENTICATED", "no connection ticket");
    }
    const ws = new WebSocket(
      gatewayWebSocketUrl(
        `/machines/${encodeURIComponent(this.options.machineId)}/rpc?ticket=${encodeURIComponent(ticket)}`,
      ),
    );
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      // 握手期间 close() 会把 state 置 idle 并关 ws；settled 保证 promise 一定落定。
      let settled = false;
      ws.onopen = () => {
        if (settled) return;
        if (this.ws !== ws || generation !== this.connectionGeneration) {
          settled = true;
          reject(new MachineRpcError("RPC_CLOSED", "stale rpc channel opened"));
          return;
        }
        settled = true;
        this.setState("connected");
        resolve();
      };
      ws.onerror = () => {
        if (!settled && this.ws === ws && this.state === "connecting") {
          settled = true;
          this.setState("error", "连接失败（电脑未运行或电脑通道离线？）");
          reject(new MachineRpcError("CONNECT_FAILED", "rpc channel connect failed"));
        }
      };
      ws.onclose = () => {
        const wasActiveSocket = this.ws === ws;
        if (wasActiveSocket) {
          this.ws = null;
          this.setState(this.state === "error" ? "error" : "disconnected");
          this.rejectAll(new MachineRpcError("RPC_CLOSED", "rpc channel closed"));
        }
        if (!settled) {
          settled = true;
          reject(new MachineRpcError("RPC_CLOSED", "rpc channel closed during connect"));
        }
      };
    });

    ws.onmessage = (ev: MessageEvent<string>) => {
      if (this.ws !== ws) return;
      let msg: ServerReply;
      try {
        msg = JSON.parse(ev.data) as ServerReply;
      } catch {
        return;
      }
      if (msg.id === null || msg.id === undefined) return; // 协议级错误（无法关联 id）
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else
        entry.reject(
          new MachineRpcError(msg.error?.code ?? "RPC_ERROR", msg.error?.message ?? "rpc failed"),
        );
    };
  }

  /** 发 RPC 请求；未连接时立即 reject；默认 15s 超时（超时 reject RPC_TIMEOUT 并清理）。 */
  call<T = unknown>(
    method: string,
    params?: unknown,
    timeoutOrOptions: number | MachineRpcCallOptions = 15_000,
  ): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new MachineRpcError("RPC_CLOSED", "rpc channel not connected"));
    }
    const options =
      typeof timeoutOrOptions === "number" ? { timeoutMs: timeoutOrOptions } : timeoutOrOptions;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const signal = options.signal;
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException("操作已取消", "AbortError"));
    }
    const id = `c${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason ?? new DOMException("操作已取消", "AbortError"));
      };
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener("abort", abort);
        reject(
          new MachineRpcError("RPC_TIMEOUT", `rpc call ${method} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(e);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(new MachineRpcError("RPC_CLOSED", `failed to send rpc call ${method}`));
      }
    });
  }

  close(): void {
    this.connectionGeneration += 1;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      ws.close();
    }
    this.rejectAll(new MachineRpcError("RPC_CLOSED", "rpc channel closed"));
    // 复位状态，避免调用方（如 MetricsCard 轮询）把已关闭的 client 当作活跃连接。
    // 服务端主动断开走的 ws.onclose（this.ws 已置空）不会覆盖此处的 idle。
    this.setState("idle");
  }

  private rejectAll(err: MachineRpcError): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
