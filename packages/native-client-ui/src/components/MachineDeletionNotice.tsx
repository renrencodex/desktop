import { LoaderCircle } from "lucide-react";

export function MachineDeletionNotice({
  count,
  compact = false,
}: {
  count: number;
  compact?: boolean;
}) {
  if (count <= 0) return null;
  return (
    <div
      role={compact ? undefined : "status"}
      aria-live={compact ? undefined : "polite"}
      data-machine-deletion-notice=""
      className={
        compact
          ? "mx-1.5 mb-1.5 flex items-start gap-2 rounded-md border border-amber-900/60 bg-amber-950/20 px-2.5 py-2 text-[10px] leading-4 text-amber-300/80"
          : "flex items-center gap-2 rounded-[var(--cm-card-radius)] border border-amber-900/60 bg-amber-950/20 px-3 py-2.5 text-xs text-amber-300/80"
      }
    >
      <LoaderCircle
        size={compact ? 12 : 14}
        className="mt-0.5 shrink-0 motion-safe:animate-spin"
        aria-hidden="true"
      />
      <span>{count} 台电脑正在后台删除，清理完成后释放创建配额。</span>
    </div>
  );
}
