let configured = false;

/** Web 与 Desktop 共用同一套本地 Monaco worker 入口；不会从 CDN 加载代码。 */
export function configureWorkspaceMonacoWorkers(): void {
  if (configured || typeof self === "undefined") return;
  configured = true;
  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      if (label === "json") {
        return new Worker(new URL("./workers/json.worker.ts", import.meta.url), { type: "module" });
      }
      if (label === "css" || label === "scss" || label === "less") {
        return new Worker(new URL("./workers/css.worker.ts", import.meta.url), { type: "module" });
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new Worker(new URL("./workers/html.worker.ts", import.meta.url), { type: "module" });
      }
      if (label === "typescript" || label === "javascript") {
        return new Worker(new URL("./workers/ts.worker.ts", import.meta.url), { type: "module" });
      }
      return new Worker(new URL("./workers/editor.worker.ts", import.meta.url), { type: "module" });
    },
  };
}
