/**
 * MachineRpcClient 连接管理 hook（从 FilesPanel 内联逻辑抽取）：
 * active=true 时自动连接，瞬时断线按指数退避自动恢复，false 或组件卸载时关闭；
 * 暴露 connState / notice 与可立即触发的手动重连 connect。
 *
 * client 按 machineId 用 useMemo 重建：详情页从电脑 A 切到电脑 B 时
 * 旧 client 在 effect cleanup 中 close()，新 client 连接新电脑，
 * 避免写操作打到旧电脑。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MachineRpcClient, type RpcConnState } from "./machine-rpc";
import { createMachineConnectionTicket } from "./connection-ticket";

export const MACHINE_RPC_RECONNECT_BASE_DELAY_MS = 500;
export const MACHINE_RPC_RECONNECT_MAX_DELAY_MS = 10_000;

export function machineRpcReconnectDelay(attempt: number): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  return Math.min(
    MACHINE_RPC_RECONNECT_MAX_DELAY_MS,
    MACHINE_RPC_RECONNECT_BASE_DELAY_MS * 2 ** safeAttempt,
  );
}

export function shouldReconnectMachineRpc(state: RpcConnState, notice: string | null): boolean {
  if (state === "disconnected") return true;
  // token/会话错误需要用户重新登录；连接握手失败则属于可恢复的网络故障。
  return state === "error" && notice !== "会话已过期，请重新登录";
}

export function useMachineRpc(machineId: string, active: boolean) {
  const [connState, setConnState] = useState<RpcConnState>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const connectingRef = useRef<{
    rpc: MachineRpcClient;
    promise: Promise<void>;
  } | null>(null);
  const reconnectAttemptRef = useRef(0);
  const rpc = useMemo(
    () =>
      new MachineRpcClient({
        machineId,
        getTicket: () => createMachineConnectionTicket(machineId, "rpc"),
        onStateChange: (state, notice) => {
          setConnState(state);
          setNotice(notice ?? null);
        },
      }),
    [machineId],
  );

  const connect = useCallback((): Promise<void> => {
    if (rpc.connState === "connected") return Promise.resolve();
    const current = connectingRef.current;
    if (current?.rpc === rpc) return current.promise;
    const promise = rpc.connect().catch(() => {
      // onStateChange 已置 error/disconnected 状态与提示。
    });
    connectingRef.current = { rpc, promise };
    void promise.finally(() => {
      if (connectingRef.current?.promise === promise) connectingRef.current = null;
    });
    return promise;
  }, [rpc]);

  useEffect(() => {
    if (!active) {
      if (connectingRef.current?.rpc === rpc) connectingRef.current = null;
      rpc.close();
      return;
    }
    reconnectAttemptRef.current = 0;
    void connect();
    // 卸载 / active=false / machineId 切换：关闭并复位旧 client。
    return () => {
      // React Strict Mode 会立即执行一次 setup → cleanup → setup。
      // 清除旧 Promise 的去重占位，让第二次 setup 能真正建立新连接。
      if (connectingRef.current?.rpc === rpc) connectingRef.current = null;
      rpc.close();
    };
  }, [active, connect, rpc]);

  useEffect(() => {
    if (!active) return;
    if (connState === "connected") {
      reconnectAttemptRef.current = 0;
      return;
    }
    if (!shouldReconnectMachineRpc(connState, notice)) return;
    const delay = machineRpcReconnectDelay(reconnectAttemptRef.current++);
    const timer = window.setTimeout(() => void connect(), delay);
    return () => window.clearTimeout(timer);
  }, [active, connState, connect, notice]);

  return { rpc, connState, notice, connect };
}
