"use client";

import { CheckCircle2, TriangleAlert, X } from "lucide-react";

import { useToastStore } from "../stores/toast";

/** 右上角通知堆叠。 */
export function Toaster() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed right-3 top-3 z-[60] flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          role="status"
          className={`pointer-events-auto flex animate-in items-center gap-2 rounded-[var(--cm-card-radius)] border px-3 py-2 text-xs shadow-[var(--cm-shadow)] slide-in-from-top-2 fade-in duration-150 ${
            item.kind === "error" ? "cm-banner-danger" : "cm-panel text-zinc-200"
          }`}
        >
          {item.kind === "error" ? (
            <TriangleAlert size={14} className="shrink-0" />
          ) : (
            <CheckCircle2 size={14} className="shrink-0 text-[var(--cm-accent)]" />
          )}
          <span className="min-w-0 flex-1">{item.message}</span>
          <button
            type="button"
            aria-label="关闭通知"
            className="cm-icon-button shrink-0"
            onClick={() => dismiss(item.id)}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
