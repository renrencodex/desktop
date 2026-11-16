"use client";

import { Group, Panel, Separator, type SeparatorProps } from "react-resizable-panels";

import { cn } from "../../lib/utils";

export const ResizablePanelGroup = Group;
export const ResizablePanel = Panel;

export function ResizableHandle({
  axis,
  className,
  ...props
}: SeparatorProps & { axis: "horizontal" | "vertical" }) {
  const vertical = axis === "vertical";

  return (
    <Separator
      className={cn(
        "relative z-10 outline-none",
        // Overlay sash: 5px hit target, ±2px margin so layout still costs 1px.
        // Coarse pointers (tablets) get a 25px hit target with the same 1px layout cost.
        vertical
          ? "w-[5px] -mx-[2px] cursor-col-resize [@media(pointer:coarse)]:w-[25px] [@media(pointer:coarse)]:-mx-[12px]"
          : "h-[5px] -my-[2px] cursor-row-resize [@media(pointer:coarse)]:h-[25px] [@media(pointer:coarse)]:-my-[12px]",
        "before:pointer-events-none before:absolute before:bg-[var(--cm-border)] before:content-[''] before:opacity-40 before:transition-[width,height,background-color,opacity] before:duration-150",
        vertical
          ? "before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 hover:before:w-[3px] hover:before:opacity-100 focus-visible:before:w-[3px] focus-visible:before:opacity-100 data-[separator=active]:before:w-[3px] data-[separator=active]:before:opacity-100"
          : "before:inset-x-0 before:top-1/2 before:h-px before:-translate-y-1/2 hover:before:h-[3px] hover:before:opacity-100 focus-visible:before:h-[3px] focus-visible:before:opacity-100 data-[separator=active]:before:h-[3px] data-[separator=active]:before:opacity-100",
        "hover:before:bg-[var(--cm-accent)] focus-visible:before:bg-[var(--cm-accent)] data-[separator=active]:before:bg-[var(--cm-accent)]",
        className,
      )}
      {...props}
    />
  );
}
