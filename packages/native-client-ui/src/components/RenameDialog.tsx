"use client";

import { useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export interface RenameDialogProps {
  open: boolean;
  initialName: string;
  busy: boolean;
  error: string | null;
  title: string;
  description: string;
  fieldLabel: string;
  emptyError: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => void;
}

/** 应用内重命名表单（电脑 / Workspace 共用），避免依赖 WebView 不可靠的 window.prompt。 */
export function RenameDialog(props: RenameDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!props.busy) props.onOpenChange(open);
      }}
    >
      <DialogContent
        className="max-w-md border-zinc-800 bg-zinc-900 text-zinc-100"
        showCloseButton={!props.busy}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const normalizedName = inputRef.current?.value.trim() ?? "";
            if (!normalizedName) {
              setValidationError(props.emptyError);
              return;
            }
            setValidationError(null);
            props.onSubmit(normalizedName);
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
            <DialogDescription className="text-zinc-400">{props.description}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-medium text-zinc-500">
                {props.fieldLabel}
              </span>
              <input
                autoFocus
                required
                maxLength={100}
                defaultValue={props.initialName}
                ref={inputRef}
                onChange={() => setValidationError(null)}
                className="cm-input"
              />
            </label>
            {(validationError ?? props.error) && (
              <p className="rounded border px-3 py-2 text-xs cm-banner-danger">
                {validationError ?? props.error}
              </p>
            )}
          </div>
          <DialogFooter className="mt-4 border-zinc-800 bg-zinc-950/40">
            <button
              type="button"
              className="cm-button"
              disabled={props.busy}
              onClick={() => props.onOpenChange(false)}
            >
              取消
            </button>
            <button type="submit" className="cm-button-primary" disabled={props.busy}>
              {props.busy ? "正在保存…" : "保存名称"}
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
