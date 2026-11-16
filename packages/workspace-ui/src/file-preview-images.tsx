"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from "react";
import {
  classifyPreviewImageReference,
  MAX_EXTERNAL_PREVIEW_IMAGES,
  type PreviewResourceIssue,
} from "./file-preview-policy";
import {
  createImageState,
  reduceImageState,
  scheduleImageDeadline,
  type ExternalImageAttempt,
} from "./file-preview-image-state";

interface ImageResources {
  image(path: string, reference: string): Promise<string | null>;
  readonly issues: ReadonlyMap<string, PreviewResourceIssue>;
}

interface ImageContext {
  path: string;
  resources: ImageResources;
  active: boolean;
  applicationOrigin: string;
  failed: ReadonlySet<string>;
  attempts: ReadonlyMap<string, ExternalImageAttempt>;
  registerExternal(url: string, requestKey: string): boolean;
  reportExternalResult(url: string, attempt: number, outcome: "loaded" | "failed"): void;
  report(issue: PreviewResourceIssue): void;
  settled(): void;
}

const Context = createContext<ImageContext | null>(null);

export function PreviewResourceNotice({
  issues,
  retry,
  images = false,
}: {
  issues: readonly PreviewResourceIssue[];
  retry?: { run(): void; pending: boolean; disabled: boolean };
  images?: boolean;
}) {
  if (!issues.length) return null;
  const blocked = issues.filter((issue) => issue.kind === "external-blocked").length;
  const externalFailed = issues.filter((issue) => issue.kind === "external-load-failed").length;
  const failed = issues.length - blocked - externalFailed;
  const summary = [
    blocked ? `已阻止 ${blocked} 个外部${images ? "图片" : "资源"}` : "",
    externalFailed ? `${externalFailed} 个外部图片加载失败` : "",
    failed ? `${failed} 个资源未加载` : "",
  ]
    .filter(Boolean)
    .join("；");
  return (
    <div className="min-w-0 shrink-0 border-b px-2 py-1 text-[11px] cm-banner-warning">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span role="status">{summary}</span>
        {externalFailed > 0 && retry && (
          <button
            type="button"
            className="cm-button"
            disabled={retry.disabled || retry.pending}
            title={retry.disabled && !retry.pending ? "点击间隔至少 5 秒，请稍后重试" : undefined}
            onClick={retry.run}
          >
            {retry.pending ? "重试中…" : "重试失败图片"}
          </button>
        )}
      </div>
      <details>
        <summary className="cursor-pointer">详情</summary>
        <ul className="max-h-40 overflow-y-auto [overflow-wrap:anywhere]">
          {issues.map((issue) => (
            <li key={issue.reference}>
              {issue.reference}：{issue.message}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** Mounted once per immutable preview session; loading/retry state stays in this instance. */
export function PreviewImages({
  path,
  resources,
  active,
  children,
}: {
  path: string;
  resources: ImageResources;
  active: boolean;
  children: ReactNode;
}) {
  const [imageState, dispatch] = useReducer(reduceImageState, active, createImageState);
  // Reset before children render, without remounting the document/scroll container.
  if (imageState.active !== active) {
    dispatch({ type: "active", active });
  }
  const externalActive = active && imageState.active;
  const generation = imageState.generation;
  const reportExternalResult = useCallback(
    (url: string, attempt: number, outcome: "loaded" | "failed") =>
      dispatch({ type: "settled", generation, url, attempt, outcome }),
    [generation],
  );
  const { retryAvailableAt, retryDeadline } = imageState;
  useEffect(() => {
    const next = Math.min(retryAvailableAt ?? Infinity, retryDeadline ?? Infinity);
    if (!Number.isFinite(next)) return;
    return scheduleImageDeadline(next, (now) => dispatch({ type: "tick", generation, now }));
  }, [generation, retryAvailableAt, retryDeadline]);
  const [external] = useState(() => new Map<string, string>());
  const [extraIssues] = useState(() => new Map<string, PreviewResourceIssue>());
  const [, setRevision] = useState(0);
  const settled = useCallback(() => setRevision((value) => value + 1), []);
  const report = useCallback(
    (issue: PreviewResourceIssue) => {
      const old = extraIssues.get(issue.reference);
      if (old?.kind === issue.kind && old.message === issue.message) return;
      extraIssues.set(issue.reference, issue);
      settled();
    },
    [extraIssues, settled],
  );
  const registerExternal = useCallback(
    (url: string, requestKey: string) => {
      if (external.has(requestKey)) return true;
      if (external.size >= MAX_EXTERNAL_PREVIEW_IMAGES) {
        report({ reference: url, kind: "resource-limit", message: "外部图片超过 64 个" });
        return false;
      }
      external.set(requestKey, url);
      settled();
      return true;
    },
    [external, report, settled],
  );
  const issues = new Map(resources.issues);
  for (const [reference, issue] of extraIssues) issues.set(reference, issue);
  for (const [reference, attempt] of imageState.attempts) {
    if (attempt.status !== "loaded") issues.set(reference, attempt.issue);
  }
  const failed = new Set(
    [...extraIssues.values()]
      .filter(
        (issue) => issue.kind === "external-load-failed" || issue.kind === "local-read-failed",
      )
      .map((issue) => issue.reference),
  );
  return (
    <Context.Provider
      value={{
        path,
        resources,
        active: externalActive,
        failed,
        attempts: imageState.attempts,
        registerExternal,
        reportExternalResult,
        report,
        settled,
        applicationOrigin: typeof window === "undefined" ? "" : window.location.origin,
      }}
    >
      <PreviewResourceNotice
        issues={[...issues.values()]}
        images
        retry={
          externalActive
            ? {
                run: () => dispatch({ type: "retry", generation, now: performance.now() }),
                pending: retryDeadline !== null,
                disabled: retryAvailableAt !== null,
              }
            : undefined
        }
      />
      {children}
    </Context.Provider>
  );
}

/** Stable Markdown component type: notice/loading updates must not remount all images. */
export function MarkdownPreviewImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const context = useContext(Context);
  if (!context) throw new Error("Missing preview image session");
  return (
    <SessionImage context={context} source={typeof src === "string" ? src : ""} alt={alt ?? ""} />
  );
}

function SessionImage({
  context,
  source,
  alt,
}: {
  context: ImageContext;
  source: string;
  alt: string;
}) {
  const { path, resources, applicationOrigin, registerExternal, report, settled } = context;
  const reference = useMemo(
    () => classifyPreviewImageReference(source, applicationOrigin),
    [source, applicationOrigin],
  );
  const [result, setResult] = useState<{
    source: string;
    path: string;
    resources: ImageResources;
    url: string | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(async () => {
        if (cancelled) return;
        let url: string | null;
        if (reference.kind === "external") {
          url = registerExternal(reference.url, reference.requestKey) ? reference.url : null;
        } else if (reference.kind === "invalid") {
          report({ reference: source, kind: "invalid-reference", message: reference.message });
          url = null;
        } else {
          url = await resources.image(path, source);
        }
        if (!cancelled) {
          setResult({ source, path, resources, url });
          settled();
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [source, path, resources, reference, registerExternal, report, settled]);
  if (result?.source !== source || result.path !== path || result.resources !== resources)
    return null;
  const external = reference.kind === "external";
  const attempt = external && result.url ? context.attempts.get(result.url) : undefined;
  if (external && result.url && !context.active)
    return <span className="text-zinc-500">[{alt || "图片"}：预览已暂停]</span>;
  if (
    !result.url ||
    attempt?.status === "failed" ||
    context.failed.has(external ? result.url : source)
  )
    return <span className="text-zinc-500">[{alt || "图片"}：未加载]</span>;
  const url = result.url;
  const attemptId = attempt?.id ?? 0;
  return (
    <img
      key={attemptId}
      src={url}
      alt={alt}
      referrerPolicy="no-referrer"
      loading={external && attemptId > 0 ? "eager" : "lazy"}
      decoding="async"
      className="max-w-full"
      onLoad={external ? () => context.reportExternalResult(url, attemptId, "loaded") : undefined}
      onError={() =>
        external
          ? context.reportExternalResult(url, attemptId, "failed")
          : report({
              reference: source,
              kind: "local-read-failed",
              message: "本地图片无法解码",
            })
      }
    />
  );
}
