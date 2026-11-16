import { useCallback, useEffect, useRef, useState } from "react";
import {
  FS_SEARCH_MAX_MATCHES,
  FS_SEARCH_MAX_RESULT_BYTES,
  FS_SEARCH_QUERY_MAX_LENGTH,
  FS_SEARCH_TIMEOUT_MS,
  fileSearchOptionsSchema,
  fileSearchServerMessageSchema,
  type FileSearchContentMatch,
  type FileSearchMatch,
  type FileSearchOptions,
  type FileSearchServerMessage,
  type FileSearchSummary,
} from "@cloud-machine/client-contracts";

export type SearchSocketFactory = (machineId: string, signal: AbortSignal) => Promise<WebSocket>;

/** No retries: a disconnect ends this disk snapshot, retaining already received results. */
export async function searchWorkspaceFiles(options: {
  machineId: string;
  workspaceId: string;
  options: FileSearchOptions;
  signal: AbortSignal;
  createSocket: SearchSocketFactory;
  onMessage: (message: FileSearchServerMessage) => void;
}): Promise<void> {
  options.signal.throwIfAborted();
  const socket = await options.createSocket(options.machineId, options.signal);
  if (options.signal.aborted) {
    socket.close();
    options.signal.throwIfAborted();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let count = 0;
    let bytes = 0;
    let ready = false;
    let resultRoot: string | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      socket.removeEventListener("open", open);
      socket.removeEventListener("message", message);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", failed);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel" }));
      finish(new DOMException("搜索已停止", "AbortError"));
    };
    const failed = () => finish(new Error("搜索连接已断开，请重新搜索"));
    const open = () =>
      socket.send(
        JSON.stringify({ type: "search", workspaceId: options.workspaceId, ...options.options }),
      );
    const message = (event: MessageEvent) => {
      try {
        if (typeof event.data !== "string" || event.data.length > 128 * 1024)
          throw new Error("无效搜索结果");
        const data = fileSearchServerMessageSchema.parse(JSON.parse(event.data));
        if (data.type === "error") {
          finish(new Error(data.message));
          return;
        }
        if (data.type === "ready") {
          if (ready) throw new Error("重复搜索握手");
          ready = true;
        } else if (!ready) throw new Error("搜索尚未就绪");
        if (data.type === "results") {
          if (resultRoot !== null && resultRoot !== data.rootPath)
            throw new Error("搜索目录发生变化");
          resultRoot = data.rootPath;
          count += data.items.length;
          bytes += data.items.reduce(
            (sum, item) => sum + new TextEncoder().encode(JSON.stringify(item)).length,
            0,
          );
          if (count > FS_SEARCH_MAX_MATCHES || bytes > FS_SEARCH_MAX_RESULT_BYTES)
            throw new Error("搜索结果超出上限");
        }
        if (data.type === "done" && data.summary.matchCount !== count)
          throw new Error("搜索结果不完整，请重试");
        options.onMessage(data);
        if (data.type === "done") finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("无效搜索结果"));
      }
    };
    const timer = setTimeout(
      () => finish(new Error("搜索超时，请缩小关键字范围后重试")),
      FS_SEARCH_TIMEOUT_MS + 20_000,
    );
    socket.addEventListener("open", open);
    socket.addEventListener("message", message);
    socket.addEventListener("error", failed);
    socket.addEventListener("close", failed);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    else if (socket.readyState === WebSocket.OPEN) open();
    else if (socket.readyState >= WebSocket.CLOSING) failed();
  });
}

export interface FileSearchState {
  view: "tree" | "search";
  draft: FileSearchOptions;
  submitted: FileSearchOptions | null;
  items: FileSearchMatch[];
  rootPath: string;
  running: boolean;
  summary: FileSearchSummary | null;
  error: string | null;
  stopped: boolean;
}
const initialState = (): FileSearchState => ({
  view: "tree",
  draft: { query: "", mode: "content", caseSensitive: false, includeIgnored: false },
  submitted: null,
  items: [],
  rootPath: "",
  running: false,
  summary: null,
  error: null,
  stopped: false,
});

export function useWorkspaceFileSearch(props: {
  scopeKey: string;
  machineId: string;
  workspaceId?: string;
  activeExplorerId: string | null;
  explorerIds: string[];
  enabled: boolean;
  createSocket: SearchSocketFactory;
}) {
  const [states, setStates] = useState<Record<string, FileSearchState>>({});
  const statesRef = useRef(states);
  const statesScopeRef = useRef(props.scopeKey);
  const current = useRef<{ id: string; controller: AbortController } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const change = useCallback((id: string, update: (state: FileSearchState) => FileSearchState) => {
    const next = { ...statesRef.current, [id]: update(statesRef.current[id] ?? initialState()) };
    statesRef.current = next;
    setStates(next);
  }, []);
  const cancel = useCallback(() => {
    const request = current.current;
    if (!request) return;
    current.current = null;
    request.controller.abort();
    change(request.id, (state) => ({ ...state, running: false, stopped: true }));
  }, [change]);
  useEffect(() => {
    return () => cancel();
  }, [cancel, props.scopeKey, props.activeExplorerId, props.enabled]);
  useEffect(() => {
    statesRef.current = {};
    statesScopeRef.current = props.scopeKey;
    setStates({});
  }, [props.scopeKey]);
  useEffect(() => {
    const ids = new Set(props.explorerIds);
    if (Object.keys(statesRef.current).some((id) => !ids.has(id))) {
      const next = Object.fromEntries(
        Object.entries(statesRef.current).filter(([id]) => ids.has(id)),
      );
      statesRef.current = next;
      setStates(next);
    }
  }, [props.explorerIds]);
  const submit = useCallback(
    (id: string) => {
      const scope = propsRef.current;
      if (!scope.enabled || !scope.workspaceId || scope.activeExplorerId !== id) return;
      const parsed = fileSearchOptionsSchema.safeParse(statesRef.current[id]?.draft);
      if (!parsed.success) {
        change(id, (state) => ({ ...state, error: "请输入不超过 512 字符的单行关键字" }));
        return;
      }
      cancel();
      const request = { id, controller: new AbortController() };
      current.current = request;
      change(id, (state) => ({
        ...state,
        view: "search",
        submitted: parsed.data,
        items: [],
        running: true,
        summary: null,
        error: null,
        stopped: false,
      }));
      void searchWorkspaceFiles({
        machineId: scope.machineId,
        workspaceId: scope.workspaceId,
        options: parsed.data,
        signal: request.controller.signal,
        createSocket: scope.createSocket,
        onMessage: (message) => {
          if (
            current.current !== request ||
            propsRef.current.scopeKey !== scope.scopeKey ||
            !propsRef.current.enabled ||
            propsRef.current.activeExplorerId !== id
          )
            return;
          change(id, (state) => {
            if (message.type === "ready") return { ...state, rootPath: message.rootPath };
            if (message.type === "results")
              return {
                ...state,
                rootPath: message.rootPath,
                items: [...state.items, ...message.items],
              };
            if (message.type === "done")
              return { ...state, running: false, summary: message.summary };
            return state;
          });
        },
      })
        .catch((error) => {
          if (current.current !== request) return;
          change(id, (state) => ({
            ...state,
            running: false,
            error: error instanceof Error ? error.message : "搜索失败",
          }));
        })
        .finally(() => {
          if (current.current === request) current.current = null;
        });
    },
    [cancel, change],
  );
  return {
    state: (id: string) =>
      statesScopeRef.current === props.scopeKey ? (states[id] ?? initialState()) : initialState(),
    setView: (id: string, view: "tree" | "search") => {
      if (view === "tree") cancel();
      change(id, (state) => ({ ...state, view }));
    },
    patchDraft: (id: string, patch: Partial<FileSearchOptions>) =>
      change(id, (state) => ({ ...state, draft: { ...state.draft, ...patch } })),
    submit,
    cancel,
  };
}

export interface FileSearchReveal {
  id: number;
  path: string;
  match: FileSearchContentMatch;
}
/** Validates against the CURRENT buffer; never reloads or discards local edits. */
export function searchMatchOffsets(
  value: string,
  match: FileSearchContentMatch,
): { start: number; end: number } | null {
  let start = 0;
  for (let line = 1; line < match.line; line++) {
    const next = value.indexOf("\n", start);
    if (next < 0) return null;
    start = next + 1;
  }
  const lineEnd = value.indexOf("\n", start);
  const end = lineEnd < 0 ? value.length : lineEnd;
  const actualStart = start + match.column - 1;
  const actualEnd = start + match.endColumn - 1;
  const expected = match.preview.slice(
    match.column - match.previewColumn,
    match.endColumn - match.previewColumn,
  );
  if (actualEnd > end || !expected || value.slice(actualStart, actualEnd) !== expected) return null;
  return { start: actualStart, end: actualEnd };
}

function summaryLabel(state: FileSearchState) {
  if (state.error) return state.error;
  if (state.running) return `搜索中 · ${state.items.length} 处匹配`;
  if (state.stopped) return `已停止 · 保留 ${state.items.length} 处匹配`;
  const summary = state.summary;
  if (!summary) return "搜索整个工作区的磁盘文件，按 Enter 开始";
  const partial = summary.reason !== "complete";
  const skipped =
    summary.skippedBinary +
    summary.skippedLarge +
    summary.skippedUnreadable +
    summary.skippedChanged;
  return `${partial ? "部分结果 · " : ""}${summary.matchedFiles} 个文件，${summary.matchCount} 处匹配${skipped ? ` · 跳过 ${skipped} 个文件` : ""}${summary.reason === "timeout" ? " · 达到 30 秒上限" : ""}${summary.reason === "limit" ? " · 达到搜索上限" : ""}${summary.error ? ` · ${summary.error.message}` : ""}`;
}

function MatchedPath({ path, options }: { path: string; options: FileSearchOptions | null }) {
  if (!options || options.mode !== "name") return <>{path}</>;
  const escaped = options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(escaped, options.caseSensitive ? "u" : "iu").exec(path);
  if (!match) return <>{path}</>;
  return (
    <>
      {path.slice(0, match.index)}
      <mark className="bg-yellow-500/25 text-inherit">{match[0]}</mark>
      {path.slice(match.index + match[0].length)}
    </>
  );
}

export function FileSearchPanel(props: {
  state: FileSearchState;
  disabled: boolean;
  visible: boolean;
  onDraft: (patch: Partial<FileSearchOptions>) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onBack: () => void;
  onOpen: (rootPath: string, match: FileSearchMatch) => void;
  onReveal: (rootPath: string, match: FileSearchMatch) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  useEffect(() => {
    if (props.visible) input.current?.focus();
  }, [props.visible]);
  const { state } = props;
  const groups = new Map<string, FileSearchMatch[]>();
  for (const item of state.items) {
    const items = groups.get(item.path) ?? [];
    items.push(item);
    groups.set(item.path, items);
  }
  const staleDraft =
    state.submitted !== null && JSON.stringify(state.draft) !== JSON.stringify(state.submitted);
  const label = summaryLabel(state);
  return (
    <section
      className="flex h-full min-h-0 flex-col text-xs"
      aria-label="工作区文件搜索"
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          composing.current
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (state.running) props.onCancel();
        props.onBack();
      }}
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-zinc-800 p-2">
        <div className="cm-file-search-query-row">
          <input
            ref={input}
            aria-label="搜索关键字"
            placeholder="输入关键字，按 Enter 搜索"
            value={state.draft.query}
            maxLength={FS_SEARCH_QUERY_MAX_LENGTH}
            className="cm-file-search-input"
            onChange={(event) => props.onDraft({ query: event.target.value })}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.nativeEvent.isComposing &&
                event.nativeEvent.keyCode !== 229 &&
                !composing.current
              ) {
                event.preventDefault();
                props.onSubmit();
              }
            }}
          />
          <button
            type="button"
            disabled={props.disabled || !state.draft.query.trim()}
            onClick={props.onSubmit}
            className="cm-file-search-action"
          >
            搜索
          </button>
          {state.running && (
            <button type="button" className="cm-file-search-action" onClick={props.onCancel}>
              停止
            </button>
          )}
        </div>
        <div className="cm-file-search-filters">
          <select
            aria-label="搜索类型"
            value={state.draft.mode}
            onChange={(event) => props.onDraft({ mode: event.target.value as "name" | "content" })}
            className="cm-file-search-mode"
          >
            <option value="content">文件内容</option>
            <option value="name">文件名 / 路径</option>
          </select>
          <div className="cm-file-search-options" role="group" aria-label="搜索选项">
            {(
              [
                ["caseSensitive", "区分大小写", "仅匹配大小写相同的文字"],
                ["includeIgnored", "包含忽略项", "同时搜索被忽略规则排除的文件"],
              ] as const
            ).map(([key, text, title]) => (
              <button
                key={key}
                type="button"
                className="cm-file-search-option"
                aria-pressed={state.draft[key]}
                title={title}
                onClick={() => props.onDraft({ [key]: !state.draft[key] })}
              >
                <svg
                  className="cm-file-search-option-check"
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="m2.5 6 2.25 2.25 4.75-4.5" />
                </svg>
                {text}
              </button>
            ))}
          </div>
        </div>
        <div
          className="h-8 overflow-hidden text-[11px] text-zinc-500"
          role="status"
          title={`${label}\n${state.rootPath}\n内容搜索上限 5 MiB。${state.summary ? `跳过：二进制 ${state.summary.skippedBinary}、过大 ${state.summary.skippedLarge}、不可读 ${state.summary.skippedUnreadable}、扫描时变更 ${state.summary.skippedChanged}` : ""}`}
        >
          <div className="truncate">{label}</div>
          <div className="truncate">
            {staleDraft
              ? `以下是“${state.submitted?.query}”的结果，修改后请重新搜索`
              : "范围：整个工作区 · 内容文件 ≤ 5 MiB"}
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {[...groups].map(([path, matches]) => (
          <div key={path} className="border-b border-zinc-800/50 py-1">
            <div className="flex items-center gap-1 px-2">
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left py-1"
                title={path}
                onClick={() => props.onOpen(state.rootPath, matches[0]!)}
              >
                <MatchedPath path={path} options={state.submitted} />
              </button>
              <button
                type="button"
                title={`在目录树中定位 ${path}`}
                aria-label={`在目录树中定位 ${path}`}
                className="shrink-0 text-[11px] text-zinc-500"
                onClick={() => props.onReveal(state.rootPath, matches[0]!)}
              >
                定位
              </button>
            </div>
            {matches.map(
              (match, index) =>
                match.kind === "content" && (
                  <button
                    key={index}
                    type="button"
                    className="flex w-full gap-2 overflow-hidden px-2 py-1 text-left hover:bg-zinc-800/40"
                    title={`${path}:${match.line}`}
                    onClick={() => props.onOpen(state.rootPath, match)}
                  >
                    <span className="shrink-0 text-zinc-500">{match.line}</span>
                    <code className="min-w-0 truncate whitespace-pre">
                      {match.preview.slice(0, match.column - match.previewColumn)}
                      <mark className="bg-yellow-500/25 text-inherit">
                        {match.preview.slice(
                          match.column - match.previewColumn,
                          match.endColumn - match.previewColumn,
                        )}
                      </mark>
                      {match.preview.slice(match.endColumn - match.previewColumn)}
                    </code>
                  </button>
                ),
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
