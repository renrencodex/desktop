"use client";

import type { EgressLineOption } from "@cloud-machine/api-client";
import { Globe2 } from "lucide-react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export function EgressLineDialog(props: {
  open: boolean;
  lines: EgressLineOption[];
  value: string;
  currentValue: string;
  busy?: boolean;
  error?: string | null;
  onValueChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onCancel()}>
      <DialogContent
        className="max-w-sm border-zinc-800 bg-zinc-900 text-xs text-zinc-100"
        showCloseButton={!props.busy}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xs">
            <Globe2 size={13} /> 切换网络线路
          </DialogTitle>
          <DialogDescription className="text-[11px] text-zinc-400">
            切换会中断当前公网连接，新连接将立即使用所选线路。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5 p-3">
          {props.lines.map((line) => {
            const active = props.value === line.id;
            return (
              <label
                key={line.id}
                className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 transition-colors ${
                  active
                    ? "border-zinc-500 bg-zinc-800 text-zinc-100"
                    : "border-zinc-800 bg-zinc-950/40 text-zinc-400 hover:border-zinc-700"
                }`}
              >
                <input
                  type="radio"
                  name="egress-line"
                  value={line.id}
                  checked={active}
                  disabled={props.busy}
                  onChange={() => props.onValueChange(line.id)}
                  className="accent-zinc-100"
                />
                <span className="flex-1">{line.displayName}</span>
                {line.isDefault && <span className="text-[10px] text-zinc-500">默认</span>}
              </label>
            );
          })}
          {props.error && <p className="text-[11px] text-red-400">{props.error}</p>}
        </div>
        <DialogFooter className="border-zinc-800 bg-zinc-950/40">
          <Button size="xs" variant="outline" onClick={props.onCancel} disabled={props.busy}>
            取消
          </Button>
          <button
            type="button"
            className="cm-button-primary"
            disabled={props.busy || !props.value || props.value === props.currentValue}
            onClick={props.onConfirm}
          >
            {props.busy ? "切换中…" : "确认切换"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
