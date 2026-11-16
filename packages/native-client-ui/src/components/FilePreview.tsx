"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  MarkdownPreviewImage,
  PreviewImages,
  PreviewResourceNotice,
} from "@cloud-machine/workspace-ui/file-preview-images";
import {
  captureFileScrollPosition,
  resolveFileScrollPosition,
  type FileScrollPosition,
} from "@cloud-machine/workspace-ui/file-scroll-position";
import { useClientHost } from "../host";
import { resolvePreviewPath, type PreviewFormat } from "../lib/file-preview";
import { PreviewResources } from "../lib/preview-resources";
import { toastError } from "../stores/toast";

const PdfFilePreview = lazy(() =>
  import("./PdfFilePreview").then((module) => ({ default: module.PdfFilePreview })),
);
export interface FilePreviewProps {
  /** Machine/workspace/explorer identity. Loading/retry state is local to this preview. */
  previewScopeKey?: string;
  path: string;
  rootPath: string;
  format: PreviewFormat;
  bytes?: Uint8Array;
  text?: string;
  active: boolean;
  readResource: (path: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;
  onOpenFile: (path: string) => void;
}

export function FilePreview(props: FilePreviewProps) {
  return (
    <FilePreviewSession
      key={JSON.stringify([props.previewScopeKey, props.path, props.rootPath, props.format.kind])}
      {...props}
    />
  );
}

function FilePreviewSession(props: FilePreviewProps) {
  const { platform } = useClientHost();
  const { path: documentPath, rootPath, onOpenFile } = props;
  const bytes = useMemo(
    () => props.bytes ?? new TextEncoder().encode(props.text ?? ""),
    [props.bytes, props.text],
  );
  const [imageUrl, setImageUrl] = useState<{ bytes: Uint8Array; url: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [previousBytes, setPreviousBytes] = useState(bytes);
  if (previousBytes !== bytes) {
    setPreviousBytes(bytes);
    setFailure(null);
  }
  const [zoom, setZoom] = useState(0);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const markdownScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingMarkdownScrollRef = useRef<FileScrollPosition | null>(null);
  const setMarkdownScrollElement = useCallback((element: HTMLDivElement | null) => {
    const previous = markdownScrollRef.current;
    if (previous && previous !== element) {
      pendingMarkdownScrollRef.current = captureFileScrollPosition(previous);
    }
    markdownScrollRef.current = element;
  }, []);
  const text = props.text ?? "";
  const kind = props.format.kind;
  const input = useMemo(
    () => ({ text, kind, path: props.path, rootPath: props.rootPath, read: props.readResource }),
    [text, kind, props.path, props.rootPath, props.readResource],
  );
  const sessionSequence = useRef(0);
  const [session, setSession] = useState<{
    input: typeof input;
    id: number;
    resources: PreviewResources;
    html?: string;
  } | null>(null);

  useEffect(() => {
    if (!["image", "svg", "audio", "video"].includes(kind)) return;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: props.format.mime }));
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) setImageUrl({ bytes, url });
    });
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
    };
  }, [bytes, kind, props.format.mime]);
  useEffect(() => {
    if (input.kind !== "markdown" && input.kind !== "html") return;
    const id = ++sessionSequence.current;
    const controller = new AbortController();
    const resources = new PreviewResources({
      rootPath: input.rootPath,
      signal: controller.signal,
      read: input.read,
    });
    const timer = window.setTimeout(() => {
      if (input.kind === "markdown") setSession({ input, id, resources });
      else
        void resources
          .html(input.text, input.path)
          .then((html) => {
            if (!controller.signal.aborted) {
              setSession({ input, id, resources, html });
            }
          })
          .catch((error) => {
            if (!controller.signal.aborted)
              setFailure(error instanceof Error ? error.message : "HTML 预览失败");
          });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      resources.dispose();
    };
  }, [input]);
  useEffect(() => {
    const pause = () => {
      if (!props.active || document.visibilityState !== "visible") mediaRef.current?.pause();
    };
    pause();
    document.addEventListener("visibilitychange", pause);
    return () => {
      document.removeEventListener("visibilitychange", pause);
      mediaRef.current?.pause();
    };
  }, [props.active]);
  const url = imageUrl?.bytes === bytes ? imageUrl.url : null;
  const currentSession = session?.input === input ? session : null;
  useLayoutEffect(() => {
    if (kind !== "markdown" || !currentSession) return;
    const element = markdownScrollRef.current;
    const position = pendingMarkdownScrollRef.current;
    if (!element || !position) return;
    const restored = resolveFileScrollPosition(position, element);
    element.scrollTop = restored.top;
    element.scrollLeft = restored.left;
    pendingMarkdownScrollRef.current = null;
  }, [currentSession, kind]);
  // 保持组件类型稳定：图片加载和警告更新不应卸载、重新读取全部图片。
  const markdownComponents = useMemo<Components>(
    () => ({
      img: MarkdownPreviewImage,
      a: ({ href, children }) => {
        if (href && /^https?:\/\//i.test(href))
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                event.preventDefault();
                void platform
                  .openExternal(href)
                  .catch(() => toastError("无法打开系统浏览器，请重试"));
              }}
            >
              {children}
            </a>
          );
        const path = href ? resolvePreviewPath(documentPath, href, rootPath) : null;
        return path ? (
          <a
            href="#"
            onClick={(event) => {
              event.preventDefault();
              onOpenFile(path);
            }}
          >
            {children}
          </a>
        ) : (
          <span>{children}</span>
        );
      },
    }),
    [documentPath, rootPath, onOpenFile, platform],
  );

  return (
    <section
      aria-label="文件预览"
      data-file-preview={kind}
      aria-busy={!failure && (kind === "html" || kind === "markdown") && !currentSession}
      className="flex h-full min-h-0 flex-col text-xs"
    >
      {kind === "html" && currentSession && (
        <PreviewResourceNotice issues={[...currentSession.resources.issues.values()]} />
      )}
      {failure ? (
        <div role="alert" className="m-auto p-4 text-center text-zinc-500">
          {failure}。可使用工具栏下载或重新加载。
        </div>
      ) : kind === "pdf" ? (
        <Suspense fallback={null}>
          <PdfFilePreview bytes={bytes} active={props.active} />
        </Suspense>
      ) : kind === "image" || kind === "svg" ? (
        <>
          <div
            role="toolbar"
            aria-label="图片缩放"
            className="flex min-h-7 shrink-0 items-center gap-1 border-b border-zinc-800 px-2 py-1"
          >
            <button type="button" className="cm-button" onClick={() => setZoom(0)}>
              适应窗口
            </button>
            <button type="button" className="cm-button" onClick={() => setZoom(1)}>
              原始尺寸
            </button>
            <button
              type="button"
              className="cm-icon-button"
              aria-label="缩小图片"
              onClick={() => setZoom((value) => Math.max(0.1, (value || 1) / 1.25))}
            >
              −
            </button>
            <button
              type="button"
              className="cm-icon-button"
              aria-label="放大图片"
              onClick={() => setZoom((value) => Math.min(8, (value || 1) * 1.25))}
            >
              +
            </button>
            <span className="ml-auto text-[10px] text-zinc-500">
              {zoom ? `${Math.round(zoom * 100)}%` : "自适应"}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {url && (
              <img
                src={url}
                alt={props.path.split("/").at(-1)}
                onLoad={(event) =>
                  setDimensions({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                onError={() => setFailure("浏览器无法解码此图片或文件已损坏")}
                className={
                  zoom ? "block max-w-none" : "mx-auto block max-h-full max-w-full object-contain"
                }
                style={
                  zoom && dimensions.width
                    ? { width: dimensions.width * zoom, height: dimensions.height * zoom }
                    : undefined
                }
              />
            )}
          </div>
        </>
      ) : kind === "audio" || kind === "video" ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-2">
          {url &&
            (kind === "audio" ? (
              <audio
                ref={(element) => {
                  mediaRef.current = element;
                }}
                src={url}
                controls
                preload="metadata"
                className="w-full"
                onError={() => setFailure("浏览器不支持此音频编码或文件已损坏")}
              />
            ) : (
              <video
                ref={(element) => {
                  mediaRef.current = element;
                }}
                src={url}
                controls
                playsInline
                preload="metadata"
                className="max-h-full w-full"
                onError={() => setFailure("浏览器不支持此视频编码或文件已损坏")}
              />
            ))}
        </div>
      ) : kind === "html" ? (
        currentSession?.html ? (
          <iframe
            title={`${props.path.split("/").at(-1)} HTML预览`}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={currentSession.html}
            className="min-h-0 w-full flex-1 border-0 bg-white"
          />
        ) : null
      ) : currentSession ? (
        <PreviewImages
          key={currentSession.id}
          path={documentPath}
          resources={currentSession.resources}
          active={props.active}
        >
          <div
            ref={setMarkdownScrollElement}
            className="cm-markdown min-h-0 flex-1 overflow-auto p-3 sm:p-4"
          >
            <Markdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              urlTransform={(reference) => reference}
              components={markdownComponents}
            >
              {text}
            </Markdown>
          </div>
        </PreviewImages>
      ) : null}
    </section>
  );
}
