"use client";

import type { AccountNotificationSummary } from "@cloud-machine/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import { userErrorMessage } from "../lib/user-error";
import { toastError } from "../stores/toast";

const SUMMARY_QUERY_KEY = ["notification-summary"] as const;
const NOTIFICATION_LIMIT = 6;

export function NotificationCenter({ onViewAll }: { onViewAll: () => void }) {
  const queryClient = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const summary = useQuery({
    queryKey: SUMMARY_QUERY_KEY,
    queryFn: () => api.account.getNotificationSummary(NOTIFICATION_LIMIT),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const refetchSummary = summary.refetch;

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  const openForPreview = () => {
    clearCloseTimer();
    setOpen(true);
  };
  const scheduleClose = () => {
    clearCloseTimer();
    if (pinned) return;
    closeTimerRef.current = setTimeout(() => setOpen(false), 180);
  };
  const close = useCallback(() => {
    clearCloseTimer();
    setOpen(false);
    setPinned(false);
  }, [clearCloseTimer]);

  useEffect(() => {
    if (open) void refetchSummary();
  }, [open, refetchSummary]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);

  useEffect(
    () => () => {
      clearCloseTimer();
    },
    [clearCloseTimer],
  );

  const markRead = useMutation({
    mutationFn: (id: string) => api.account.markNotificationRead(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SUMMARY_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ["notifications"] }),
      ]);
    },
    onError: (error) => toastError(userErrorMessage(error, "消息标记失败，请重试")),
  });
  const markAllRead = useMutation({
    mutationFn: () => api.account.markAllNotificationsRead(),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: SUMMARY_QUERY_KEY });
      const previous = queryClient.getQueryData<AccountNotificationSummary>(SUMMARY_QUERY_KEY);
      const optimisticReadAt = new Date().toISOString();
      queryClient.setQueryData<AccountNotificationSummary>(SUMMARY_QUERY_KEY, (current) =>
        current
          ? {
              unreadCount: 0,
              items: current.items.map((item) => ({
                ...item,
                readAt: item.readAt ?? optimisticReadAt,
              })),
            }
          : current,
      );
      return { previous, optimisticReadAt };
    },
    onSuccess: (result, _variables, context) => {
      queryClient.setQueryData<AccountNotificationSummary>(SUMMARY_QUERY_KEY, (current) =>
        current
          ? {
              ...current,
              items: current.items.map((item) => ({
                ...item,
                readAt: item.readAt === context.optimisticReadAt ? result.readAt : item.readAt,
              })),
            }
          : current,
      );
    },
    onError: (error, _variables, context) => {
      if (context?.previous)
        queryClient.setQueryData<AccountNotificationSummary>(SUMMARY_QUERY_KEY, context.previous);
      toastError(userErrorMessage(error, "全部已读失败，请重试"));
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: SUMMARY_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ["notifications"] }),
      ]);
    },
  });

  const unreadCount = summary.data?.unreadCount ?? 0;
  return (
    <div
      ref={rootRef}
      className="relative ml-1"
      onMouseEnter={openForPreview}
      onMouseLeave={scheduleClose}
      onFocus={openForPreview}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !pinned) scheduleClose();
      }}
    >
      <button
        type="button"
        className="cm-icon-button cm-touch-square relative"
        title={unreadCount > 0 ? "消息，" + unreadCount + " 条未读" : "消息"}
        aria-label={unreadCount > 0 ? "打开消息，" + unreadCount + " 条未读" : "打开消息"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          clearCloseTimer();
          if (open && pinned) close();
          else {
            setOpen(true);
            setPinned(true);
          }
        }}
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span
            className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold leading-4 text-white"
            aria-hidden="true"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <section
          role="dialog"
          aria-label="消息中心"
          className="fixed top-[calc(var(--cm-viewport-offset-top,0px)+var(--cm-titlebar-height)+6px)] right-[max(.5rem,env(safe-area-inset-right,0px))] z-50 flex max-h-[min(420px,calc(100vh-56px))] w-[min(360px,calc(100vw-1rem-env(safe-area-inset-left,0px)-env(safe-area-inset-right,0px)))] flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
          onMouseEnter={clearCloseTimer}
          onMouseLeave={scheduleClose}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold text-zinc-100">消息</h2>
              {unreadCount > 0 && (
                <span className="text-[10px] text-zinc-500">{unreadCount} 条未读</span>
              )}
            </div>
            <button
              type="button"
              className="text-[11px] text-[var(--cm-accent)] disabled:cursor-default disabled:text-zinc-600"
              disabled={unreadCount === 0 || markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
            >
              {markAllRead.isPending ? "处理中…" : "全部已读"}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {summary.isPending ? (
              <div className="space-y-3 p-3" aria-label="正在加载消息">
                {[0, 1, 2].map((item) => (
                  <div key={item} className="h-14 animate-pulse rounded-lg bg-zinc-800/70" />
                ))}
              </div>
            ) : summary.isError ? (
              <div className="p-4 text-center">
                <p className="text-xs text-red-400">
                  {userErrorMessage(summary.error, "消息加载失败")}
                </p>
                <button
                  type="button"
                  className="mt-2 text-xs text-[var(--cm-accent)]"
                  onClick={() => void summary.refetch()}
                >
                  重试
                </button>
              </div>
            ) : summary.data.items.length === 0 ? (
              <p className="p-6 text-center text-xs text-zinc-500">暂无消息</p>
            ) : (
              <div className="divide-y divide-zinc-800">
                {summary.data.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={
                      "flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-zinc-800/70 " +
                      (item.readAt ? "opacity-70" : "bg-[var(--cm-accent)]/5")
                    }
                    disabled={markRead.isPending && markRead.variables === item.id}
                    onClick={() => {
                      if (!item.readAt) markRead.mutate(item.id);
                    }}
                  >
                    <span
                      className={
                        "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full " +
                        (item.readAt ? "bg-zinc-700" : "bg-[var(--cm-accent)]")
                      }
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-zinc-200">
                        {item.title}
                      </span>
                      <span className="mt-0.5 line-clamp-2 block whitespace-pre-line text-[11px] leading-4 text-zinc-500">
                        {item.body}
                      </span>
                      <time
                        className="mt-1 block text-[10px] text-zinc-600"
                        dateTime={item.createdAt}
                      >
                        {new Date(item.createdAt).toLocaleString()}
                      </time>
                    </span>
                    {!item.readAt && <span className="sr-only">未读</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            className="shrink-0 border-t border-zinc-800 px-3 py-2.5 text-center text-xs text-zinc-400 transition-colors hover:bg-zinc-800/70 hover:text-zinc-200"
            onClick={() => {
              close();
              onViewAll();
            }}
          >
            查看全部消息
          </button>
        </section>
      )}
    </div>
  );
}
