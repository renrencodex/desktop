"use client";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { useNativePreviewOverlayTracking } from "../../lib/native-preview-occlusion";
import { cn } from "../../lib/utils";

export function ContextMenu({
  onOpenChange,
  onOpenChangeComplete,
  ...props
}: ContextMenuPrimitive.Root.Props) {
  const tracking = useNativePreviewOverlayTracking({
    open: props.open,
    defaultOpen: props.defaultOpen,
    onOpenChange,
    onOpenChangeComplete,
  });
  return <ContextMenuPrimitive.Root {...props} {...tracking} />;
}

export function ContextMenuTrigger(props: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />;
}

export function ContextMenuContent({ className, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="isolate z-50 outline-none">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "z-50 min-w-40 rounded-lg bg-popover p-1 text-[10px] leading-4 text-popover-foreground shadow-[var(--cm-shadow)] ring-1 ring-[var(--cm-border)] outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  destructive,
  ...props
}: ContextMenuPrimitive.Item.Props & { destructive?: boolean }) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      className={cn(
        "group/context-menu-item relative flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 select-none data-disabled:pointer-events-none data-disabled:opacity-40",
        destructive
          ? "text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive data-[highlighted]:**:text-destructive dark:data-[highlighted]:bg-destructive/20"
          : "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[highlighted]:**:text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function ContextMenuSeparator(props: ContextMenuPrimitive.Separator.Props) {
  return <ContextMenuPrimitive.Separator className="my-1 h-px bg-border" {...props} />;
}
