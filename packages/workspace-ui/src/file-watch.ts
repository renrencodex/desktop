import { useEffect, useRef, useState } from "react";

import { fileWatchServerMessageSchema } from "@cloud-machine/client-contracts";

export type FileWatchSocketFactory = (machineId: string, signal: AbortSignal) => Promise<WebSocket>;

export interface FileWatchInvalidation {
  sequence: number | null;
  resync: boolean;
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let timer: number | null = null;
    const finish = () => {
      if (timer !== null) window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = window.setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export async function watchMachineFileOnce(options: {
  machineId: string;
  path: string;
  signal: AbortSignal;
  createSocket: FileWatchSocketFactory;
  onReady?: () => void;
  onInvalidate: (event: FileWatchInvalidation) => void;
}): Promise<void> {
  options.signal.throwIfAborted();
  const socket = await options.createSocket(options.machineId, options.signal);
  if (options.signal.aborted) {
    socket.close();
    options.signal.throwIfAborted();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let ready = false;
    let lastSequence = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", abort);
      socket.removeEventListener("open", open);
      socket.removeEventListener("message", message);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", failed);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish();
    const failed = () => finish(new Error("文件自动刷新连接已断开"));
    const open = () => socket.send(JSON.stringify({ type: "watch", path: options.path }));
    const message = (event: MessageEvent) => {
      try {
        if (typeof event.data !== "string" || event.data.length > 8 * 1024)
          throw new Error("无效的文件自动刷新消息");
        const data = fileWatchServerMessageSchema.parse(JSON.parse(event.data));
        if (data.type === "error") throw new Error(data.message);
        if (data.type === "ready") {
          if (ready) throw new Error("重复的文件自动刷新握手");
          ready = true;
          options.onReady?.();
          options.onInvalidate({ sequence: null, resync: true });
          return;
        }
        if (!ready) throw new Error("文件自动刷新通道尚未就绪");
        if (data.sequence <= lastSequence) return;
        const resync = data.resync || data.sequence !== lastSequence + 1;
        lastSequence = data.sequence;
        options.onInvalidate({ sequence: data.sequence, resync });
      } catch (error) {
        finish(error instanceof Error ? error : new Error("无效的文件自动刷新消息"));
      }
    };
    socket.addEventListener("open", open);
    socket.addEventListener("message", message);
    socket.addEventListener("error", failed);
    socket.addEventListener("close", failed);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    else if (socket.readyState === WebSocket.OPEN) open();
    else if (socket.readyState >= WebSocket.CLOSING) failed();
  });
}

export function useMachineFileWatch(options: {
  machineId: string;
  path: string | null;
  enabled: boolean;
  createSocket: FileWatchSocketFactory;
  onInvalidate: (event: FileWatchInvalidation) => void;
}): void {
  const callbackRef = useRef(options.onInvalidate);
  callbackRef.current = options.onInvalidate;
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );

  useEffect(() => {
    const visibility = () => setVisible(document.visibilityState !== "hidden");
    const focus = () => {
      if (options.enabled && options.path && document.visibilityState !== "hidden")
        callbackRef.current({ sequence: null, resync: true });
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
    };
  }, [options.enabled, options.path]);

  useEffect(() => {
    if (!options.enabled || !options.path || !visible) return;
    const controller = new AbortController();
    let attempt = 0;
    const run = async () => {
      while (!controller.signal.aborted) {
        let reachedReady = false;
        try {
          await watchMachineFileOnce({
            machineId: options.machineId,
            path: options.path!,
            signal: controller.signal,
            createSocket: options.createSocket,
            onReady: () => {
              reachedReady = true;
              attempt = 0;
            },
            onInvalidate: (event) => callbackRef.current(event),
          });
        } catch {
          // A dedicated watch failure must not break file editing. Retry below; each successful
          // handshake begins with a full reconciliation so no event is trusted as content.
        }
        if (controller.signal.aborted) return;
        const delay = Math.min(10_000, 500 * 2 ** Math.min(attempt, 5));
        attempt = reachedReady ? 0 : attempt + 1;
        await waitForRetry(delay, controller.signal);
      }
    };
    void run();
    return () => controller.abort();
  }, [options.createSocket, options.enabled, options.machineId, options.path, visible]);
}
