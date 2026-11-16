import type {
  ApiClient,
  Workspace,
  WorkspaceDiffEntry,
  WorkspaceDiffFileResult,
  WorkspaceDiffResult,
} from "@cloud-machine/api-client";
import {
  createWorkspaceDiffLineClassifier,
  type FsEntry,
  type MachineConnectionChannel,
} from "@cloud-machine/client-contracts";
import { useQuery } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import "@xterm/xterm/css/xterm.css";

import { configureWorkspaceMonacoWorkers } from "./monaco";
import { installGhosttyBackgroundPixelAlignment } from "./terminal-canvas-selection";
import {
  buildWorkspaceDiffTree,
  type WorkspaceDiffRepositoryTree,
  type WorkspaceDiffTreeNode,
} from "./workspace-diff-tree";
import {
  listWorkspaceDirectory,
  readWorkspaceFile,
  WorkspaceRpcClient,
  type WorkspaceRpcState,
  writeWorkspaceFile,
} from "./workspace-rpc";

export interface CloudWorkspaceWorkbenchProps {
  api: ApiClient;
  machineId: string;
  workspaceId: string;
  gatewayWsUrl: string;
  onDirtyChange?: (dirty: boolean) => void;
}

type WorkbenchView = "files" | "terminal" | "diff";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function workspaceMatchesRoute(
  routeMachineId: string,
  workspaceMachineId?: string,
): boolean {
  return workspaceMachineId !== undefined && routeMachineId === workspaceMachineId;
}

export function isCurrentGeneration(request: number, current: number): boolean {
  return request === current;
}

export function canApplyFileRead(
  request: number,
  currentRequest: number,
  editAtStart: number,
  currentEdit: number,
): boolean {
  return isCurrentGeneration(request, currentRequest) && editAtStart === currentEdit;
}

export function CloudWorkspaceWorkbench(props: CloudWorkspaceWorkbenchProps) {
  const workspace = useQuery({
    queryKey: ["workspace", props.workspaceId],
    queryFn: () => props.api.workspaces.get(props.workspaceId),
  });
  if (workspace.isPending) {
    return <div className="cm-shared-message">正在载入工作区…</div>;
  }
  if (workspace.error || !workspace.data) {
    return (
      <div className="cm-shared-message cm-shared-error">
        {errorMessage(workspace.error, "工作区加载失败")}
      </div>
    );
  }
  if (!workspaceMatchesRoute(props.machineId, workspace.data.machineId)) {
    return <div className="cm-shared-message cm-shared-error">工作区不属于当前路由中的电脑</div>;
  }
  return <VerifiedCloudWorkspaceWorkbench {...props} workspace={workspace.data} />;
}

function VerifiedCloudWorkspaceWorkbench(
  props: CloudWorkspaceWorkbenchProps & { workspace: Workspace },
) {
  const [view, setView] = useState<WorkbenchView>("files");
  const machine = useQuery({
    queryKey: ["machine", props.machineId],
    queryFn: () => props.api.machines.get(props.machineId),
  });
  const status = useQuery({
    queryKey: ["workspace-status", props.machineId, props.workspaceId],
    queryFn: () => {
      if (!workspaceMatchesRoute(props.machineId, props.workspace.machineId)) {
        throw new Error("工作区与路由电脑不匹配");
      }
      return props.api.workspaces.status(props.workspaceId);
    },
    refetchInterval: 10_000,
  });
  const [rpcState, setRpcState] = useState<WorkspaceRpcState>("idle");
  const [rpcNotice, setRpcNotice] = useState<string | null>(null);
  const getConnectionTicket = useCallback(
    async (channel: MachineConnectionChannel) =>
      (
        await props.api.machines.createConnectionTicket(
          props.machineId,
          channel,
          crypto.randomUUID(),
        )
      ).ticket,
    [props.api, props.machineId],
  );
  const rpc = useMemo(
    () =>
      new WorkspaceRpcClient({
        machineId: props.machineId,
        gatewayWsUrl: props.gatewayWsUrl,
        getTicket: () => getConnectionTicket("rpc"),
        onStateChange: (next, notice) => {
          setRpcState(next);
          setRpcNotice(notice ?? null);
        },
      }),
    [getConnectionTicket, props.gatewayWsUrl, props.machineId, props.workspaceId],
  );
  const connect = useCallback(() => rpc.connect().catch(() => undefined), [rpc]);

  useEffect(() => {
    if (status.data?.state !== "available") {
      rpc.close();
      return;
    }
    void connect();
    return () => rpc.close();
  }, [connect, rpc, status.data?.state]);

  if (machine.isPending) {
    return <div className="cm-shared-message">正在载入工作区…</div>;
  }
  if (machine.error || !machine.data) {
    return (
      <div className="cm-shared-message cm-shared-error">
        {errorMessage(machine.error, "电脑加载失败")}
      </div>
    );
  }
  const available = status.data?.state === "available";
  return (
    <section className="cm-shared-workbench">
      <header className="cm-shared-workbench-header">
        <div className="cm-shared-workbench-title">
          <strong>{props.workspace.name}</strong>
          <span>{props.workspace.path}</span>
        </div>
        <div className="cm-shared-tabs" role="tablist" aria-label="工作区工具">
          <WorkbenchTab active={view === "files"} onClick={() => setView("files")}>
            Files / Monaco
          </WorkbenchTab>
          <WorkbenchTab active={view === "terminal"} onClick={() => setView("terminal")}>
            Terminal
          </WorkbenchTab>
          <WorkbenchTab active={view === "diff"} onClick={() => setView("diff")}>
            Git Diff
          </WorkbenchTab>
        </div>
        <span className={`cm-shared-connection cm-shared-connection-${rpcState}`}>
          {rpcState === "connected" ? "已连接" : (rpcNotice ?? "连接中")}
        </span>
      </header>
      {!available && !status.isPending && (
        <div className="cm-shared-banner">
          工作区暂不可用（{status.data?.state ?? "状态查询失败"}）
        </div>
      )}
      <div className="cm-shared-workbench-content">
        <div hidden={view !== "files"} className="cm-shared-view">
          <WorkspaceFiles
            rpc={rpc}
            connected={rpcState === "connected"}
            rootPath={props.workspace.path}
            onReconnect={connect}
            onDirtyChange={props.onDirtyChange}
          />
        </div>
        <div hidden={view !== "terminal"} className="cm-shared-view">
          <WorkspaceTerminal
            active={view === "terminal" && available}
            machineId={props.machineId}
            workspaceId={props.workspaceId}
            cwd={props.workspace.path}
            gatewayWsUrl={props.gatewayWsUrl}
            getConnectionTicket={() => getConnectionTicket("terminal")}
          />
        </div>
        <div hidden={view !== "diff"} className="cm-shared-view">
          <WorkspaceDiff api={props.api} workspaceId={props.workspaceId} active={view === "diff"} />
        </div>
      </div>
    </section>
  );
}

function WorkbenchTab(props: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      className="cm-shared-tab"
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent.replace(/\/$/, "")}/${name}`;
}

export function workspaceParentPath(path: string, rootPath: string): string {
  if (path === rootPath) return rootPath;
  const parent = path.slice(0, path.lastIndexOf("/"));
  const rootPrefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  return parent === rootPath || parent.startsWith(rootPrefix) ? parent : rootPath;
}

function languageForPath(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return (
    {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      json: "json",
      css: "css",
      html: "html",
      md: "markdown",
      py: "python",
      rs: "rust",
      go: "go",
      sh: "shell",
    }[extension ?? ""] ?? "plaintext"
  );
}

function WorkspaceFiles(props: {
  rpc: WorkspaceRpcClient;
  connected: boolean;
  rootPath: string;
  onReconnect: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [activeRoot, setActiveRoot] = useState(props.rootPath);
  const [path, setPath] = useState(props.rootPath);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [directoryLoading, setDirectoryLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const directoryGeneration = useRef(0);
  const fileGeneration = useRef(0);
  const editGeneration = useRef(0);
  const pathRef = useRef(path);
  const selectedRef = useRef(selected);
  const onDirtyChangeRef = useRef(props.onDirtyChange);
  const dirty = value !== savedValue;
  const rootSwitchBlocked = activeRoot !== props.rootPath;
  pathRef.current = path;
  selectedRef.current = selected;
  onDirtyChangeRef.current = props.onDirtyChange;

  useEffect(() => {
    props.onDirtyChange?.(dirty);
  }, [dirty, props.onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChangeRef.current?.(false);
    },
    [],
  );

  const resetForRoot = useCallback((nextRoot: string) => {
    directoryGeneration.current++;
    fileGeneration.current++;
    editGeneration.current++;
    setActiveRoot(nextRoot);
    setPath(nextRoot);
    setEntries([]);
    setSelected(null);
    setValue("");
    setSavedValue("");
    setDirectoryLoading(false);
    setFileLoading(false);
    setSaving(false);
    setError(null);
  }, []);

  useEffect(() => {
    if (props.rootPath === activeRoot) return;
    directoryGeneration.current++;
    fileGeneration.current++;
    setDirectoryLoading(false);
    setFileLoading(false);
    if (dirty) {
      setError("工作区根目录已变化；为保护未保存修改，已暂停切换");
      return;
    }
    resetForRoot(props.rootPath);
  }, [activeRoot, dirty, props.rootPath, resetForRoot]);

  const loadDirectory = useCallback(
    async (nextPath: string, invalidateFileRead = true) => {
      if (!props.connected || activeRoot !== props.rootPath) return;
      if (invalidateFileRead) {
        fileGeneration.current++;
        setFileLoading(false);
      }
      const generation = ++directoryGeneration.current;
      setDirectoryLoading(true);
      setError(null);
      try {
        const next = await listWorkspaceDirectory(props.rpc, nextPath);
        if (!isCurrentGeneration(generation, directoryGeneration.current)) return;
        setEntries(
          [...next].sort(
            (left, right) =>
              Number(right.type === "directory") - Number(left.type === "directory") ||
              left.name.localeCompare(right.name),
          ),
        );
        setPath(nextPath);
      } catch (loadError) {
        if (!isCurrentGeneration(generation, directoryGeneration.current)) return;
        setError(errorMessage(loadError, "目录读取失败"));
      } finally {
        if (isCurrentGeneration(generation, directoryGeneration.current))
          setDirectoryLoading(false);
      }
    },
    [activeRoot, props.connected, props.rootPath, props.rpc],
  );

  useEffect(() => {
    if (!props.connected || activeRoot !== props.rootPath) {
      directoryGeneration.current++;
      fileGeneration.current++;
      setDirectoryLoading(false);
      setFileLoading(false);
      setSaving(false);
      return;
    }
    void loadDirectory(pathRef.current);
  }, [activeRoot, loadDirectory, props.connected, props.rootPath]);

  const openFile = async (filePath: string) => {
    if (rootSwitchBlocked || saving) return;
    if (dirty && !window.confirm("当前文件有未保存修改，确定放弃吗？")) return;
    directoryGeneration.current++;
    setDirectoryLoading(false);
    const generation = ++fileGeneration.current;
    const editAtStart = editGeneration.current;
    setFileLoading(true);
    setError(null);
    try {
      const content = await readWorkspaceFile(props.rpc, filePath);
      if (
        !canApplyFileRead(
          generation,
          fileGeneration.current,
          editAtStart,
          editGeneration.current,
        ) ||
        activeRoot !== props.rootPath
      )
        return;
      setSelected(filePath);
      setValue(content);
      setSavedValue(content);
    } catch (openError) {
      if (!isCurrentGeneration(generation, fileGeneration.current)) return;
      setError(errorMessage(openError, "文件读取失败"));
    } finally {
      if (isCurrentGeneration(generation, fileGeneration.current)) setFileLoading(false);
    }
  };

  const save = async () => {
    if (!selected || !dirty || saving || rootSwitchBlocked) return;
    const filePath = selected;
    const valueToSave = value;
    const savedAtStart = savedValue;
    const generation = fileGeneration.current;
    setSaving(true);
    setError(null);
    try {
      const remote = await readWorkspaceFile(props.rpc, filePath);
      if (
        !isCurrentGeneration(generation, fileGeneration.current) ||
        selectedRef.current !== filePath
      )
        return;
      if (remote !== savedAtStart) throw new Error("远端文件已变化，请重新打开后再保存");
      await writeWorkspaceFile(props.rpc, filePath, valueToSave);
      if (
        !isCurrentGeneration(generation, fileGeneration.current) ||
        selectedRef.current !== filePath
      )
        return;
      setSavedValue(valueToSave);
      await loadDirectory(pathRef.current, false);
    } catch (saveError) {
      if (!isCurrentGeneration(generation, fileGeneration.current)) return;
      setError(errorMessage(saveError, "保存失败"));
    } finally {
      if (isCurrentGeneration(generation, fileGeneration.current)) setSaving(false);
    }
  };

  const onEditorChange = (nextValue: string) => {
    editGeneration.current++;
    setValue(nextValue);
  };

  return (
    <div className="cm-shared-files">
      <aside className="cm-shared-file-tree">
        <div className="cm-shared-file-toolbar">
          <button
            type="button"
            disabled={!props.connected || rootSwitchBlocked || saving || path === activeRoot}
            onClick={() => void loadDirectory(workspaceParentPath(path, activeRoot))}
          >
            ↑
          </button>
          <span title={path}>{path}</span>
          <button
            type="button"
            disabled={!props.connected || rootSwitchBlocked || saving}
            onClick={() => void loadDirectory(path)}
          >
            ↻
          </button>
        </div>
        {!props.connected ? (
          <button
            type="button"
            className="cm-shared-action"
            onClick={() => void props.onReconnect()}
          >
            重新连接电脑通道
          </button>
        ) : (
          <ul className="cm-shared-file-list">
            {entries.map((entry) => {
              const entryPath = joinPath(path, entry.name);
              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    className={selected === entryPath ? "is-active" : ""}
                    disabled={rootSwitchBlocked || saving}
                    onClick={() =>
                      entry.type === "directory"
                        ? void loadDirectory(entryPath)
                        : void openFile(entryPath)
                    }
                  >
                    <span>{entry.type === "directory" ? "▸" : "·"}</span>
                    <span>{entry.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
      <div className="cm-shared-editor">
        <div className="cm-shared-editor-toolbar">
          <span>{selected ?? "选择文件开始编辑"}</span>
          {selected && dirty && <span className="cm-shared-dirty">未保存</span>}
          <button
            type="button"
            disabled={!selected || !dirty || saving || rootSwitchBlocked}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
        {selected ? (
          <MonacoFileEditor
            key={selected}
            path={selected}
            value={value}
            onChange={onEditorChange}
            onSave={() => void save()}
          />
        ) : (
          <div className="cm-shared-empty">
            {directoryLoading || fileLoading ? "读取中…" : "未打开文件"}
          </div>
        )}
        {rootSwitchBlocked && (
          <div className="cm-shared-inline-error">
            <span>工作区已切换，当前未保存内容仍保留且不会写入新工作区。</span>
            <button type="button" onClick={() => resetForRoot(props.rootPath)}>
              放弃修改并切换
            </button>
          </div>
        )}
        {error && (
          <div role="alert" className="cm-shared-inline-error">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function MonacoFileEditor(props: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const callbacks = useRef({ onChange: props.onChange, onSave: props.onSave });
  callbacks.current = { onChange: props.onChange, onSave: props.onSave };
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let disposed = false;
    let cleanup = () => undefined;
    void import("monaco-editor").then((monaco) => {
      if (disposed) return;
      configureWorkspaceMonacoWorkers();
      const model = monaco.editor.createModel(props.value, languageForPath(props.path));
      const editor = monaco.editor.create(element, {
        model,
        theme: "vs-dark",
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
      });
      const change = editor.onDidChangeModelContent(() =>
        callbacks.current.onChange(model.getValue()),
      );
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
        callbacks.current.onSave(),
      );
      cleanup = () => {
        change.dispose();
        editor.dispose();
        model.dispose();
      };
    });
    return () => {
      disposed = true;
      cleanup();
    };
    // File identity owns the model; subsequent edits originate inside this editor.
  }, [props.path]);
  return <div ref={container} className="cm-shared-monaco" />;
}

function WorkspaceDiff(props: { api: ApiClient; workspaceId: string; active: boolean }) {
  const query = useQuery({
    queryKey: ["workspace-diff", props.workspaceId],
    queryFn: () => props.api.workspaces.diff(props.workspaceId),
    enabled: props.active,
    refetchInterval: props.active ? 3000 : false,
  });
  const repositories = useMemo(
    () => buildWorkspaceDiffTree(query.data?.files ?? [], query.data?.repositories),
    [query.data?.files, query.data?.repositories],
  );
  if (query.isPending) return <div className="cm-shared-empty">正在读取 Git 变更…</div>;
  if (query.error)
    return (
      <div className="cm-shared-message cm-shared-error">
        {errorMessage(query.error, "差异加载失败")}
      </div>
    );
  if (!query.data) return <div className="cm-shared-empty">差异数据不可用</div>;
  const notices = workspaceDiffListNotices(query.data);
  return (
    <div className="cm-shared-diff-list">
      {notices.map((notice) => (
        <div key={notice} role="status" className="cm-shared-diff-notice">
          {notice}
        </div>
      ))}
      {!query.data.isGit ? (
        <div className="cm-shared-empty">当前项目内未发现 Git 仓库</div>
      ) : (
        query.data.files.length === 0 && <div className="cm-shared-empty">暂无文件变更</div>
      )}
      {query.data.isGit && repositories.length > 0 && (
        <div className="cm-shared-diff-tree">
          {repositories.map((repository) => (
            <SharedDiffRepository
              key={`${props.workspaceId}:${repository.repositoryPath}`}
              api={props.api}
              workspaceId={props.workspaceId}
              repository={repository}
              active={props.active}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const sharedDiffGroups = { staged: "已暂存", unstaged: "未暂存", untracked: "未跟踪" };
const sharedDiffStatuses = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
  copied: "复制",
  conflicted: "冲突",
  untracked: "新增",
};

function sharedDiffIndent(depth: number): CSSProperties {
  return { paddingInlineStart: `${6 + Math.min(depth, 6) * 12}px` };
}

function SharedDiffBranch(props: {
  label: string;
  description?: string;
  count?: number;
  kind: "repository" | "group" | "directory";
  depth: number;
  defaultOpen: boolean;
  active: boolean;
  children: (visible: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="cm-shared-diff-branch"
    >
      <summary
        className="cm-shared-diff-row"
        data-kind={props.kind}
        style={sharedDiffIndent(props.depth)}
      >
        <span className={`cm-shared-diff-caret${open ? " is-open" : ""}`} aria-hidden="true">
          ›
        </span>
        <span className="cm-shared-diff-node-icon" aria-hidden="true" />
        <span className="cm-shared-diff-label-group">
          <span className="cm-shared-diff-label" title={props.label}>
            {props.label}
          </span>
          {props.description && (
            <span className="cm-shared-diff-description" title={props.description}>
              {props.description}
            </span>
          )}
        </span>
        {props.count !== undefined && <span className="cm-shared-diff-count">{props.count}</span>}
      </summary>
      <div>{props.children(props.active && open)}</div>
    </details>
  );
}

function SharedDiffRepository(props: {
  api: ApiClient;
  workspaceId: string;
  repository: WorkspaceDiffRepositoryTree;
  active: boolean;
}) {
  const description =
    props.repository.remoteUrl === undefined
      ? undefined
      : `仓库地址：${props.repository.remoteUrl ?? "未配置远程仓库"}`;
  return (
    <SharedDiffBranch
      label={props.repository.repositoryPath || "当前项目"}
      description={description}
      count={props.repository.count}
      kind="repository"
      depth={0}
      defaultOpen
      active={props.active}
    >
      {(repositoryActive) =>
        props.repository.groups.map((group) => (
          <SharedDiffBranch
            key={group.group}
            label={sharedDiffGroups[group.group]}
            count={group.count}
            kind="group"
            depth={1}
            defaultOpen
            active={repositoryActive}
          >
            {(groupActive) => (
              <SharedDiffNodes
                api={props.api}
                workspaceId={props.workspaceId}
                nodes={group.children}
                depth={2}
                active={groupActive}
              />
            )}
          </SharedDiffBranch>
        ))
      }
    </SharedDiffBranch>
  );
}

function SharedDiffNodes(props: {
  api: ApiClient;
  workspaceId: string;
  nodes: readonly WorkspaceDiffTreeNode[];
  depth: number;
  active: boolean;
}) {
  return props.nodes.map((node) =>
    node.kind === "directory" ? (
      <SharedDiffBranch
        key={`directory:${node.path}`}
        label={node.name}
        kind="directory"
        depth={props.depth}
        defaultOpen={false}
        active={props.active}
      >
        {(directoryActive) => (
          <SharedDiffNodes
            api={props.api}
            workspaceId={props.workspaceId}
            nodes={node.children}
            depth={props.depth + 1}
            active={directoryActive}
          />
        )}
      </SharedDiffBranch>
    ) : (
      <DiffFile
        key={`${node.entry.group}:${node.entry.path}`}
        api={props.api}
        workspaceId={props.workspaceId}
        file={node.entry}
        name={node.name}
        oldPath={node.oldPath}
        depth={props.depth}
        active={props.active}
      />
    ),
  );
}

function DiffFile(props: {
  api: ApiClient;
  workspaceId: string;
  file: WorkspaceDiffEntry;
  name: string;
  oldPath?: string;
  depth: number;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["workspace-diff", props.workspaceId, props.file.group, props.file.path],
    queryFn: () =>
      props.api.workspaces.diffFile(props.workspaceId, {
        group: props.file.group,
        path: props.file.path,
      }),
    enabled: open && props.active,
    refetchInterval: open && props.active ? 3000 : false,
  });
  const lines = useMemo(() => {
    const classify = createWorkspaceDiffLineClassifier();
    return query.data?.patch.split("\n").map((text) => ({ text, kind: classify(text) })) ?? [];
  }, [query.data?.patch]);
  const notices = query.data ? workspaceDiffPatchNotices(query.data) : [];
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="cm-shared-diff-file"
    >
      <summary
        className="cm-shared-diff-row"
        data-kind="file"
        style={sharedDiffIndent(props.depth)}
        title={props.oldPath ? `${props.oldPath} → ${props.file.path}` : props.file.path}
      >
        <span className={`cm-shared-diff-caret${open ? " is-open" : ""}`} aria-hidden="true">
          ›
        </span>
        <span className="cm-shared-diff-node-icon" aria-hidden="true" />
        <span className="cm-shared-diff-status">{sharedDiffStatuses[props.file.status]}</span>
        <strong className="cm-shared-diff-label">
          {props.oldPath ? `${props.oldPath} → ` : ""}
          {props.name}
        </strong>
      </summary>
      <pre className="cm-shared-diff-patch">
        {query.isPending && "加载补丁…"}
        {query.error && errorMessage(query.error, "补丁加载失败")}
        {notices.map((notice) => (
          <code key={notice} data-kind="metadata">
            {notice}
          </code>
        ))}
        {lines.map((line, index) => (
          <code key={index} data-kind={line.kind}>
            {line.text || " "}
          </code>
        ))}
      </pre>
    </details>
  );
}

export function workspaceDiffListNotices(
  result: Pick<WorkspaceDiffResult, "truncated" | "scanTruncated">,
): string[] {
  const notices: string[] = [];
  if (result.truncated) notices.push("文件列表已截断，可能还有未显示的变更");
  if (result.scanTruncated) notices.push("仓库扫描已截断，结果可能不完整");
  return notices;
}

export function workspaceDiffPatchNotices(
  result: Pick<WorkspaceDiffFileResult, "binary" | "submodule" | "truncated">,
): string[] {
  const notices: string[] = [];
  if (result.binary) notices.push("二进制文件：不显示文本补丁");
  if (result.submodule) notices.push("子模块变更");
  if (result.truncated) notices.push("补丁已截断");
  return notices;
}

interface BasicTerminalRenderer {
  readonly cols: number;
  readonly rows: number;
  write(data: Uint8Array): void;
  reset(): void;
  fit(): void;
  focus(): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onResize(listener: (size: { cols: number; rows: number }) => void): { dispose(): void };
  dispose(): void;
}

async function createBasicTerminalRenderer(
  element: HTMLElement,
): Promise<{ renderer: BasicTerminalRenderer; backend: "ghostty" | "xterm" }> {
  try {
    const module = await import("ghostty-web");
    const ghostty = await module.Ghostty.load("/wasm/ghostty-vt-0.4.0.wasm");
    const terminal = new module.Terminal({
      ghostty,
      fontFamily: "ui-monospace, monospace",
      fontSize: 13,
      theme: { background: "#111610", foreground: "#dfe6d6" },
      scrollback: 10_000,
    });
    const fit = new module.FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    const stopBackgroundPixelAlignment = installGhosttyBackgroundPixelAlignment(terminal.renderer);
    return {
      backend: "ghostty",
      renderer: {
        get cols() {
          return terminal.cols;
        },
        get rows() {
          return terminal.rows;
        },
        write: (data) => terminal.write(data),
        reset: () => terminal.reset(),
        fit: () => fit.fit(),
        focus: () => terminal.focus(),
        onData: (listener) => terminal.onData(listener),
        onResize: (listener) => terminal.onResize(listener),
        dispose: () => {
          stopBackgroundPixelAlignment();
          terminal.dispose();
        },
      },
    };
  } catch {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]);
    const terminal = new Terminal({
      fontFamily: "ui-monospace, monospace",
      fontSize: 13,
      theme: { background: "#111610", foreground: "#dfe6d6" },
      scrollback: 10_000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    return {
      backend: "xterm",
      renderer: {
        get cols() {
          return terminal.cols;
        },
        get rows() {
          return terminal.rows;
        },
        write: (data) => terminal.write(data),
        reset: () => terminal.reset(),
        fit: () => fit.fit(),
        focus: () => terminal.focus(),
        onData: (listener) => terminal.onData(listener),
        onResize: (listener) => terminal.onResize(listener),
        dispose: () => terminal.dispose(),
      },
    };
  }
}

function decodeTerminalData(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeTerminalData(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function WorkspaceTerminal(props: {
  active: boolean;
  machineId: string;
  workspaceId: string;
  cwd: string;
  gatewayWsUrl: string;
  getConnectionTicket: () => Promise<string>;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const [notice, setNotice] = useState("准备终端…");
  const [attempt, setAttempt] = useState(0);
  const session = useMemo(() => stableTerminalSession(props.workspaceId), [props.workspaceId]);
  useEffect(() => {
    const element = container.current;
    if (!element || !props.active) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let renderer: BasicTerminalRenderer | null = null;
    const subscriptions: Array<{ dispose(): void }> = [];
    const observer = new ResizeObserver(() => renderer?.fit());
    observer.observe(element);
    void createBasicTerminalRenderer(element)
      .then(async (created) => {
        if (disposed) {
          created.renderer.dispose();
          return;
        }
        renderer = created.renderer;
        renderer.fit();
        setNotice(created.backend === "ghostty" ? "正在连接…" : "Ghostty 不可用，使用兼容终端");
        const ticket = await props.getConnectionTicket();
        if (disposed) return;
        socket = new WebSocket(
          `${props.gatewayWsUrl.replace(/\/$/, "")}/machines/${encodeURIComponent(props.machineId)}/terminal?ticket=${encodeURIComponent(ticket)}`,
        );
        socket.onopen = () => {
          renderer?.fit();
          socket?.send(
            JSON.stringify({
              type: "attach",
              workspaceId: props.workspaceId,
              terminalTabId: session.terminalTabId,
              paneId: session.paneId,
              cwd: props.cwd,
              cols: renderer?.cols ?? 80,
              rows: renderer?.rows ?? 24,
            }),
          );
        };
        socket.onmessage = (event: MessageEvent<string>) => {
          const message = JSON.parse(event.data) as {
            type?: string;
            data?: string;
            snapshot?: string;
            message?: string;
          };
          if (message.type === "opened") {
            renderer?.reset();
            if (message.snapshot) renderer?.write(decodeTerminalData(message.snapshot));
            setNotice("");
            renderer?.focus();
          } else if (message.type === "output" && message.data) {
            renderer?.write(decodeTerminalData(message.data));
          } else if (message.type === "error" || message.type === "taken_over") {
            setNotice(message.message ?? "终端连接已结束");
          }
        };
        socket.onerror = () => setNotice("终端连接失败");
        socket.onclose = () => !disposed && setNotice("终端已断开");
        subscriptions.push(
          renderer.onData((data) => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "input", data: encodeTerminalData(data) }));
            }
          }),
          renderer.onResize(({ cols, rows }) => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "resize", cols, rows }));
            }
          }),
        );
      })
      .catch((error: unknown) => !disposed && setNotice(errorMessage(error, "终端初始化失败")));
    return () => {
      disposed = true;
      observer.disconnect();
      for (const subscription of subscriptions) subscription.dispose();
      socket?.close();
      renderer?.dispose();
      element.replaceChildren();
    };
  }, [
    attempt,
    props.active,
    props.cwd,
    props.gatewayWsUrl,
    props.getConnectionTicket,
    props.machineId,
    props.workspaceId,
    session,
  ]);
  return (
    <div className="cm-shared-terminal">
      {notice && (
        <div className="cm-shared-terminal-notice">
          <span>{notice}</span>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            重连
          </button>
        </div>
      )}
      <div ref={container} className="cm-shared-terminal-canvas" />
    </div>
  );
}

export function stableTerminalSession(workspaceId: string): {
  terminalTabId: string;
  paneId: string;
} {
  return { terminalTabId: workspaceId, paneId: "main" };
}
