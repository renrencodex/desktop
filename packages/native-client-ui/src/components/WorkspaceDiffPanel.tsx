"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, File, Folder, FolderGit2, GitBranch, RefreshCw } from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  createWorkspaceDiffLineClassifier,
  type WorkspaceDiffEntry,
} from "@cloud-machine/client-contracts";
import {
  buildWorkspaceDiffTree,
  type WorkspaceDiffRepositoryTree,
  type WorkspaceDiffTreeNode,
} from "@cloud-machine/workspace-ui/workspace-diff-tree";
import { api } from "../lib/api";
import { userErrorMessage } from "../lib/user-error";

const groups = { staged: "已暂存", unstaged: "未暂存", untracked: "未跟踪" };
const statuses: Record<WorkspaceDiffEntry["status"], { label: string; className: string }> = {
  added: { label: "新增", className: "text-emerald-400" },
  modified: { label: "修改", className: "text-amber-400" },
  deleted: { label: "删除", className: "text-red-400" },
  renamed: { label: "重命名", className: "text-sky-400" },
  copied: { label: "复制", className: "text-emerald-400" },
  conflicted: { label: "冲突", className: "text-red-400" },
  untracked: { label: "新增", className: "text-emerald-400" },
};

export function WorkspaceDiffPanel({
  workspaceId,
  active,
  available,
  statusPending,
}: {
  workspaceId: string;
  active: boolean;
  available: boolean;
  /** 状态查询未就绪时为 true：期间不显示"电脑离线"提示，避免刷新时误报闪现。 */
  statusPending?: boolean;
}) {
  const enabled = active && available;
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const query = useQuery({
    queryKey: ["workspace-diff", workspaceId],
    queryFn: () => api.workspaces.diff(workspaceId),
    enabled,
    retry: false,
    staleTime: 0,
    refetchInterval: enabled ? 3000 : false,
    refetchOnWindowFocus: enabled,
  });
  const repositories = useMemo(
    () => buildWorkspaceDiffTree(query.data?.files ?? [], query.data?.repositories),
    [query.data?.files, query.data?.repositories],
  );
  const refresh = async () => {
    if (!available || manualRefreshing) return;
    setManualRefreshing(true);
    try {
      await query.refetch({ cancelRefetch: false });
    } finally {
      setManualRefreshing(false);
    }
  };
  return (
    <section aria-label="文件变动" className="h-full min-h-0 overflow-auto bg-zinc-950 p-3 text-xs">
      <header className="mb-3 flex items-center gap-2">
        <h2 className="font-medium">文件变动</h2>
        <span className="min-w-0 flex-1 text-zinc-500">当前项目 · Git 变更</span>
        <button
          className="cm-icon-button"
          aria-label="刷新文件变动"
          disabled={!available || manualRefreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} className={manualRefreshing ? "motion-safe:animate-spin" : ""} />
        </button>
      </header>
      {!available && !statusPending && (
        <p role="status" className="mb-3 text-zinc-500">
          电脑离线或项目不可用，差异未更新
        </p>
      )}
      {query.isError && (
        <p role="alert" className="mb-3 text-red-400">
          {userErrorMessage(query.error, "文件变动加载失败，请重试")}{" "}
          {query.data && "当前显示上次结果，尚未更新"}
        </p>
      )}
      {query.data && !query.data.isGit && (
        <p className="text-zinc-500">当前项目及扫描范围内未发现 Git 仓库</p>
      )}
      {query.data?.isGit && query.data.files.length === 0 && !query.data.scanTruncated && (
        <p className="text-zinc-500">暂无文件变更</p>
      )}
      {query.data?.truncated && (
        <p role="status" className="mb-3 text-amber-500">
          结果较大，仅显示部分变更（最多 1000 项或 1 MiB）
        </p>
      )}
      {query.data?.scanTruncated && (
        <p role="status" className="mb-3 text-amber-500">
          子仓库扫描不完整，可能遗漏更深或更多仓库
        </p>
      )}
      {repositories.length > 0 && (
        <div role="group" aria-label="变动文件目录树" className="cm-diff-tree">
          {repositories.map((repository) => (
            <RepositoryBranch
              key={`${workspaceId}:${repository.repositoryPath}`}
              workspaceId={workspaceId}
              repository={repository}
              active={enabled}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function treeIndent(depth: number): CSSProperties {
  return { paddingInlineStart: `${4 + Math.min(depth, 6) * 12}px` };
}

function TreeBranch({
  label,
  description,
  detail,
  icon,
  depth,
  defaultOpen,
  active,
  children,
}: {
  label: string;
  description?: string;
  detail?: ReactNode;
  icon: ReactNode;
  depth: number;
  defaultOpen: boolean;
  active: boolean;
  children: (visible: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="cm-diff-tree-branch"
    >
      <summary
        className="cm-diff-tree-row flex cursor-pointer list-none items-center gap-1.5 py-1 pr-2 hover:bg-zinc-900 [&::-webkit-details-marker]:hidden"
        style={treeIndent(depth)}
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}
        />
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block truncate" title={label}>
            {label}
          </span>
          {description && (
            <span
              className="block truncate text-[10px] leading-3 text-zinc-500"
              title={description}
            >
              {description}
            </span>
          )}
        </span>
        {detail}
      </summary>
      <div>{children(active && open)}</div>
    </details>
  );
}

function RepositoryBranch({
  workspaceId,
  repository,
  active,
}: {
  workspaceId: string;
  repository: WorkspaceDiffRepositoryTree;
  active: boolean;
}) {
  const label = repository.repositoryPath || "当前项目";
  const description =
    repository.remoteUrl === undefined
      ? undefined
      : `仓库地址：${repository.remoteUrl ?? "未配置远程仓库"}`;
  return (
    <TreeBranch
      label={label}
      description={description}
      detail={<span className="text-zinc-500">{repository.count}</span>}
      icon={<FolderGit2 size={13} className="shrink-0 text-emerald-500" aria-hidden="true" />}
      depth={0}
      defaultOpen
      active={active}
    >
      {(repositoryActive) =>
        repository.groups.map((group) => (
          <TreeBranch
            key={group.group}
            label={groups[group.group]}
            detail={<span className="text-zinc-500">{group.count}</span>}
            icon={<GitBranch size={12} className="shrink-0 text-zinc-500" aria-hidden="true" />}
            depth={1}
            defaultOpen
            active={repositoryActive}
          >
            {(groupActive) => (
              <DiffTreeNodes
                workspaceId={workspaceId}
                nodes={group.children}
                depth={2}
                active={groupActive}
              />
            )}
          </TreeBranch>
        ))
      }
    </TreeBranch>
  );
}

function DiffTreeNodes({
  workspaceId,
  nodes,
  depth,
  active,
}: {
  workspaceId: string;
  nodes: readonly WorkspaceDiffTreeNode[];
  depth: number;
  active: boolean;
}) {
  return nodes.map((node) =>
    node.kind === "directory" ? (
      <TreeBranch
        key={`directory:${node.path}`}
        label={node.name}
        icon={<Folder size={12} className="shrink-0 text-zinc-500" aria-hidden="true" />}
        depth={depth}
        defaultOpen
        active={active}
      >
        {(directoryActive) => (
          <DiffTreeNodes
            workspaceId={workspaceId}
            nodes={node.children}
            depth={depth + 1}
            active={directoryActive}
          />
        )}
      </TreeBranch>
    ) : (
      <DiffFile
        key={`${node.entry.group}:${node.entry.path}`}
        workspaceId={workspaceId}
        file={node.entry}
        name={node.name}
        oldPath={node.oldPath}
        depth={depth}
        active={active}
      />
    ),
  );
}

function DiffFile({
  workspaceId,
  file,
  name,
  oldPath,
  depth,
  active,
}: {
  workspaceId: string;
  file: WorkspaceDiffEntry;
  name: string;
  oldPath?: string;
  depth: number;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const status = statuses[file.status];
  const enabled = open && active;
  const query = useQuery({
    queryKey: ["workspace-diff", workspaceId, "file", file.group, file.path],
    queryFn: () => api.workspaces.diffFile(workspaceId, { path: file.path, group: file.group }),
    enabled,
    retry: false,
    staleTime: 0,
    refetchInterval: enabled ? 3000 : false,
    refetchOnWindowFocus: enabled,
  });
  const lines = useMemo(() => {
    const classify = createWorkspaceDiffLineClassifier();
    return query.data?.patch.split("\n").map((text) => ({ text, kind: classify(text) })) ?? [];
  }, [query.data?.patch]);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="cm-diff-tree-file overflow-hidden"
    >
      <summary
        className="cm-diff-tree-row flex cursor-pointer list-none items-center gap-1.5 py-1 pr-2 hover:bg-zinc-900 [&::-webkit-details-marker]:hidden"
        style={treeIndent(depth)}
        title={oldPath ? `${oldPath} → ${file.path}` : file.path}
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-zinc-500 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <File size={12} className="shrink-0 text-zinc-500" aria-hidden="true" />
        <span data-diff-status={file.status} className={`shrink-0 font-medium ${status.className}`}>
          {status.label}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {oldPath ? `${oldPath} → ` : ""}
          {name}
        </span>
        <span className="inline-block min-w-20 shrink-0 whitespace-nowrap tabular-nums">
          {query.data && (
            <>
              <span className="text-emerald-500">+{query.data.additions}</span>{" "}
              <span className="text-red-400">-{query.data.deletions}</span>
            </>
          )}
        </span>
      </summary>
      {open && (
        <div className="cm-diff-tree-patch border-y border-zinc-800 bg-zinc-900/30 p-3">
          {query.isError && (
            <p role="alert" className="text-red-400">
              {userErrorMessage(query.error, "补丁未更新，请刷新后重试")}
            </p>
          )}
          {query.data?.submodule ? (
            <p>子模块已变更；请进入子模块查看具体差异</p>
          ) : query.data?.binary ? (
            <p>二进制文件已变更，无法显示文本补丁</p>
          ) : (
            <pre className="overflow-auto text-xs">
              <code>
                {lines.map(({ text, kind }, index) => (
                  <span
                    key={index}
                    className={`block min-h-[1em] ${kind === "addition" ? "text-emerald-500" : kind === "deletion" ? "text-red-400" : "text-zinc-400"}`}
                  >
                    {text || " "}
                  </span>
                ))}
              </code>
            </pre>
          )}
          {query.data?.truncated && (
            <p className="mt-2 text-amber-500">
              补丁超过 1 MiB，仅显示部分内容；行数统计也仅包含已显示内容
            </p>
          )}
        </div>
      )}
    </details>
  );
}
