"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";

const MAX_CANVAS_PIXELS = 16_000_000;
export function PdfFilePreview({ bytes, active }: { bytes: Uint8Array; active: boolean }) {
  const passwordId = useId();
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(0);
  const [width, setWidth] = useState(300);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(true);
  const [password, setPassword] = useState("");
  const [passwordPrompt, setPasswordPrompt] = useState<{
    update: (password: string) => void;
    incorrect: boolean;
  } | null>(null);
  const [previousBytes, setPreviousBytes] = useState(bytes);
  if (previousBytes !== bytes) {
    setPreviousBytes(bytes);
    setDocument(null);
    setError(null);
    setPasswordPrompt(null);
    setPassword("");
    setPageNumber(1);
    setRendering(true);
  }
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(100, element.clientWidth - 16)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | undefined;
    void import("pdfjs-dist/legacy/build/pdf.mjs")
      .then(async (pdfjs) => {
        if (cancelled) return;
        const base = `/pdfjs/${pdfjs.version}/`;
        pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
        loading = pdfjs.getDocument({
          data: bytes.slice(),
          cMapUrl: `${base}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${base}standard_fonts/`,
          wasmUrl: `${base}wasm/`,
          maxImageSize: MAX_CANVAS_PIXELS,
          enableXfa: false,
        });
        loading.onPassword = (update: (value: string) => void, reason: number) => {
          if (!cancelled)
            setPasswordPrompt({
              update,
              incorrect: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD,
            });
        };
        const result = await loading.promise;
        if (!cancelled) {
          setDocument(result);
          setPasswordPrompt(null);
          setPassword("");
        }
      })
      .catch((failure) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "PDF 加载失败");
      });
    return () => {
      cancelled = true;
      void loading?.destroy().catch(() => {});
    };
  }, [bytes]);
  useEffect(() => {
    if (!document || !active) return;
    let cancelled = false;
    let task: RenderTask | undefined;
    let pdfPage: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | undefined;
    void Promise.resolve()
      .then(async () => {
        if (cancelled) return;
        setRendering(true);
        setError(null);
        const page = await document.getPage(pageNumber);
        pdfPage = page;
        if (cancelled) {
          page.cleanup();
          return;
        }
        const original = page.getViewport({ scale: 1 });
        const scale = zoom || width / original.width;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const pixelScale = Math.min(
          scale * dpr,
          Math.sqrt(MAX_CANVAS_PIXELS / (original.width * original.height)),
        );
        const viewport = page.getViewport({ scale: pixelScale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.style.width = `${original.width * scale}px`;
        canvas.style.height = `${original.height * scale}px`;
        task = page.render({ canvas, viewport });
        await task.promise;
        if (!cancelled) setRendering(false);
      })
      .catch((failure) => {
        if (!cancelled) {
          setRendering(false);
          setError(failure instanceof Error ? failure.message : "PDF 渲染失败");
        }
      });
    return () => {
      cancelled = true;
      task?.cancel();
      void task?.promise.catch(() => {}).then(() => pdfPage?.cleanup());
    };
  }, [document, pageNumber, zoom, width, active]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="toolbar"
        aria-label="PDF翻页与缩放"
        className="flex min-h-7 shrink-0 flex-wrap items-center gap-1 border-b border-zinc-800 px-2 py-1"
      >
        <button
          type="button"
          className="cm-button"
          disabled={!document || pageNumber <= 1}
          onClick={() => setPageNumber((page) => page - 1)}
        >
          上一页
        </button>
        <span className="text-[10px] text-zinc-500" aria-label="PDF页码">
          {pageNumber} / {document?.numPages ?? "—"}
        </span>
        <button
          type="button"
          className="cm-button"
          disabled={!document || pageNumber >= document.numPages}
          onClick={() => setPageNumber((page) => page + 1)}
        >
          下一页
        </button>
        <button type="button" className="cm-button" onClick={() => setZoom(0)}>
          适应宽度
        </button>
        <button
          type="button"
          className="cm-icon-button"
          aria-label="缩小PDF"
          onClick={() => setZoom((value) => Math.max(0.25, (value || 1) / 1.25))}
        >
          −
        </button>
        <button
          type="button"
          className="cm-icon-button"
          aria-label="放大PDF"
          onClick={() => setZoom((value) => Math.min(4, (value || 1) * 1.25))}
        >
          +
        </button>
      </div>
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-auto p-2"
        aria-busy={rendering && !error && !passwordPrompt}
      >
        {passwordPrompt ? (
          <form
            className="mx-auto flex max-w-xs flex-col gap-2 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              passwordPrompt.update(password);
              setPassword("");
              setPasswordPrompt(null);
            }}
          >
            <label htmlFor={passwordId}>
              {passwordPrompt.incorrect ? "密码错误，请重试" : "此 PDF 需要密码"}
            </label>
            <input
              id={passwordId}
              type="password"
              className="cm-input"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button type="submit" className="cm-button" disabled={!password}>
              打开PDF
            </button>
          </form>
        ) : error ? (
          <p role="alert" className="p-3 text-zinc-500">
            PDF 无法预览：{error}。可使用工具栏下载或重新加载。
          </p>
        ) : (
          <>
            {rendering && <span role="status" aria-label="正在加载 PDF 页面" className="sr-only" />}
            <canvas
              ref={canvasRef}
              aria-label={`PDF第${pageNumber}页`}
              className={`mx-auto block bg-white ${rendering ? "invisible" : ""}`}
            />
          </>
        )}
      </div>
    </div>
  );
}
