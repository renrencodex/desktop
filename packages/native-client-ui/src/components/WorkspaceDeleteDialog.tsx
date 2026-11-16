"use client";

import type { Workspace } from "@cloud-machine/api-client";
import { useState } from "react";

import { ConfirmDialog } from "./ConfirmDialog";

export interface WorkspaceDeleteDialogProps {
  workspace: Workspace;
  busy?: boolean;
  hasUnsavedFiles?: boolean;
  onCancel: () => void;
  onConfirm: (deleteFiles: boolean) => void;
}

function deleteModeLocked(workspace: Workspace): boolean {
  if (workspace.lifecycleStatus !== "deleting") return false;
  if (!workspace.deleteFilesRequested) return true;
  return !workspace.deleteFilesDowngradeAllowed;
}

function lockedModeHint(workspace: Workspace): string | null {
  if (!deleteModeLocked(workspace)) return null;
  return workspace.deleteFilesRequested
    ? "此前的彻底删除结果尚未确认，需要继续按彻底删除方式重试"
    : "此前已按保留文件方式开始删除，重试时不能切换为彻底删除";
}

export function WorkspaceDeleteDialog(props: WorkspaceDeleteDialogProps) {
  const { workspace } = props;
  const [deleteFiles, setDeleteFiles] = useState(workspace.deleteFilesRequested);
  const modeLocked = deleteModeLocked(workspace);
  const modeHint = lockedModeHint(workspace);

  return (
    <ConfirmDialog
      open
      title="删除项目"
      body={
        <>
          <span className="block">
            删除项目“{workspace.name}”？默认只移除项目登记，磁盘文件会继续保留
          </span>
          <label
            className={`mt-3 flex items-start gap-2 rounded-[8px] border border-zinc-700 bg-zinc-950/50 p-2.5 ${modeLocked || props.busy ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}
          >
            <input
              type="checkbox"
              className="cm-checkbox-danger mt-0.5 h-3.5 w-3.5 shrink-0"
              checked={deleteFiles}
              disabled={modeLocked || props.busy}
              onChange={(event) => setDeleteFiles(event.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-zinc-200">彻底删除项目文件</span>
              <span className="mt-0.5 block text-[10px] leading-4 text-zinc-500">
                永久删除 <code className="text-zinc-300">{workspace.path}</code>{" "}
                及其全部内容，无法恢复
              </span>
            </span>
          </label>
          {modeHint && <span className="mt-2 block text-[10px] text-amber-400">{modeHint}</span>}
          {props.hasUnsavedFiles && (
            <span className="mt-2 block text-[var(--cm-danger)]">
              {deleteFiles
                ? "当前工作台还有未保存文件，这些编辑内容也会永久丢失"
                : "当前工作台有未保存文件；解除登记后，这些编辑内容将丢失"}
            </span>
          )}
        </>
      }
      confirmLabel={deleteFiles ? "彻底删除" : "删除"}
      busy={props.busy}
      onCancel={props.onCancel}
      onConfirm={() => props.onConfirm(deleteFiles)}
    />
  );
}
