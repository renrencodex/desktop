/** 二次确认对话框（57.12：删除电脑等敏感操作必须二次确认）。 */
"use client";

import type { ReactNode } from "react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onCancel()}>
      <DialogContent
        className="max-w-md border-zinc-800 bg-zinc-900 text-xs text-zinc-100"
        showCloseButton={!props.busy}
      >
        <DialogHeader>
          <DialogTitle className="text-xs">{props.title}</DialogTitle>
          <DialogDescription className="text-xs text-zinc-400">{props.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="border-zinc-800 bg-zinc-950/40">
          <Button size="xs" variant="outline" onClick={props.onCancel} disabled={props.busy}>
            取消
          </Button>
          <button
            type="button"
            className="cm-button-danger"
            onClick={props.onConfirm}
            disabled={props.busy || props.confirmDisabled}
          >
            {props.busy ? "执行中…" : props.confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
