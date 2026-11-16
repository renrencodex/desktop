import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PlatformApi, PreviewWebviewBounds } from "@cloud-machine/platform-api";
import { WorkbenchBrowser } from "@cloud-machine/native-client-ui/components/WorkbenchBrowser";
import { ResponsiveWorkbenchShell } from "@cloud-machine/native-client-ui/components/ResponsiveWorkbenchShell";
import { ThemeMenu } from "@cloud-machine/native-client-ui/components/ThemeMenu";
import { ClientUiProvider, type ClientHostConfig } from "@cloud-machine/native-client-ui/host";
import { useResponsiveViewport } from "@cloud-machine/native-client-ui/lib/responsive";
import {
  desktopLayoutGate,
  getDesktopLayoutState,
  setDesktopLayoutState,
} from "@cloud-machine/native-client-ui/lib/desktop-layout-state";
import {
  createTerminalRenderer,
  type TerminalRenderer,
} from "@cloud-machine/native-client-ui/lib/terminal-renderer";
import { bindDesktopWindowViewport } from "../src/desktop-window-viewport";
import type { Window as NativeWindow } from "@tauri-apps/api/window";

export interface PreviewFixture {
  captureDelay: number;
  boundsDelay: number;
  captureFails: boolean;
  onPreviewShow(): void;
  calls: {
    kind: string;
    id: string;
    bounds?: PreviewWebviewBounds;
    cover?: boolean;
    time: number;
  }[];
  toggle(): void;
  activate(active: boolean): void;
  split(): void;
  suspendViewport(suspended: boolean): void;
  setSidebarSize(size: number): void;
  layoutWrites: number[];
  native: {
    width: number;
    height: number;
    minimized: boolean;
    scaleFactor: number;
    fails: boolean;
  };
  bindViewport(): void;
  minimize(): void;
  syncNative(): void;
  layoutState: typeof getDesktopLayoutState;
  openTerminal(backend: "auto" | "xterm"): Promise<void>;
  fitTerminal(): void;
  writeTerminal(text: string): void;
  focusTerminal(): void;
  terminalSelection(): string;
  terminalSize(): { cols: number; rows: number; backend: string };
  terminalResizes: Array<{ cols: number; rows: number }>;
  terminalInput: string[];
  unmount(): void;
}

declare global {
  interface Window {
    previewFixture: PreviewFixture;
  }
}

const fixture: PreviewFixture = {
  captureDelay: 0,
  boundsDelay: 0,
  captureFails: false,
  onPreviewShow() {},
  calls: [],
  toggle() {},
  activate() {},
  split() {},
  suspendViewport() {},
  setSidebarSize() {},
  layoutWrites: [],
  native: {
    width: innerWidth,
    height: innerHeight,
    minimized: false,
    scaleFactor: devicePixelRatio,
    fails: false,
  },
  bindViewport() {},
  minimize() {},
  syncNative() {},
  layoutState: getDesktopLayoutState,
  async openTerminal() {},
  fitTerminal() {},
  writeTerminal() {},
  focusTerminal() {},
  terminalSelection: () => "",
  terminalSize: () => ({ cols: 0, rows: 0, backend: "" }),
  terminalResizes: [],
  terminalInput: [],
  unmount() {},
};
window.previewFixture = fixture;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const canvas = document.createElement("canvas");
canvas.width = 100;
canvas.height = 60;
const context = canvas.getContext("2d")!;
context.fillStyle = "#008080";
context.fillRect(0, 0, 100, 60);
const dataUrl = canvas.toDataURL("image/png");
const url = "https://80-example.preview.renrencodex.com";
const record = (kind: string, id: string, bounds?: PreviewWebviewBounds) => {
  fixture.calls.push({
    kind,
    id,
    bounds,
    cover: !!document.querySelector(`[data-isolated-preview="${id}"] img`),
    time: performance.now(),
  });
};
const isolatedPreview: PlatformApi["isolatedPreview"] = {
  async open({ id, bounds }) {
    record("open", id, bounds);
  },
  async close({ id }) {
    record("close", id);
  },
  async setBounds({ id, bounds }) {
    record("bounds", id, bounds);
    await delay(fixture.boundsDelay);
  },
  async setVisible({ id, visible }) {
    record(visible ? "show" : "hide", id);
    if (visible) fixture.onPreviewShow();
  },
  async capture({ id }) {
    record("capture", id);
    await delay(fixture.captureDelay);
    if (fixture.captureFails) throw Error("capture failed");
    return { dataUrl };
  },
};
// Deliberately mock only the API and native capabilities exercised by these actual components.
const host = {
  api: {
    ports: {
      list: async () => [
        { port: 80, address: "0.0.0.0", protocol: "tcp", visibility: "public", previewUrl: url },
      ],
    },
  },
  platform: {
    capabilities: new Set(["isolated-preview"]),
    isolatedPreview,
  },
} as unknown as ClientHostConfig;
const client = new QueryClient();
const root = createRoot(document.getElementById("root")!);
let binding: ReturnType<typeof bindDesktopWindowViewport> | undefined;
let terminal: TerminalRenderer | undefined;
fixture.unmount = () => {
  root.unmount();
  terminal?.dispose();
  binding?.dispose();
};
fixture.openTerminal = async (backend) => {
  const host = document.createElement("div");
  host.id = "terminal-probe";
  host.style.cssText =
    "position:absolute;left:0;top:100px;width:100vw;height:300px;z-index:100;background:black";
  document.body.append(host);
  terminal = await createTerminalRenderer(host, {
    fontFamily: "monospace",
    fontSize: 14,
    theme: {},
    backend,
    layoutGate: desktopLayoutGate,
    keyboardHost: { copy() {}, paste() {} },
  });
  terminal.onResize((size) => fixture.terminalResizes.push(size));
  terminal.onData((data) => fixture.terminalInput.push(data));
  terminal.setFocused(true);
  terminal.fit();
  fixture.fitTerminal = () => terminal!.fit();
  fixture.writeTerminal = (text) => terminal!.write(text);
  fixture.focusTerminal = () => terminal!.focus();
  fixture.terminalSelection = () => terminal!.getSelection();
  fixture.terminalSize = () => ({
    cols: terminal!.cols,
    rows: terminal!.rows,
    backend: terminal!.backend,
  });
};
fixture.bindViewport = () => {
  binding?.dispose();
  const events = new Set<() => void>();
  const onEvent = async (callback: () => void) => {
    events.add(callback);
    return () => {
      events.delete(callback);
    };
  };
  fixture.syncNative = () => events.forEach((callback) => callback());
  binding = bindDesktopWindowViewport(
    {
      innerSize: async () => {
        if (fixture.native.fails) throw Error("native read failed");
        return { width: fixture.native.width, height: fixture.native.height };
      },
      isMinimized: async () => fixture.native.minimized,
      scaleFactor: async () => fixture.native.scaleFactor,
      onFocusChanged: onEvent,
      onResized: onEvent,
      onScaleChanged: onEvent,
      hide: async () => {
        fixture.native.minimized = true;
        fixture.syncNative();
      },
    } as unknown as NativeWindow,
    window,
  );
  fixture.minimize = binding.hideToTray;
};

function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [active, setActive] = useState(true);
  const [split, setSplit] = useState(false);
  const [sidebarSize, setSidebarSize] = useState<number | null>(null);
  const { isCompact, isPhone } = useResponsiveViewport();
  useEffect(() => {
    fixture.toggle = () => setCollapsed((value) => !value);
    fixture.activate = setActive;
    fixture.split = () => setSplit(true);
    fixture.setSidebarSize = setSidebarSize;
    fixture.suspendViewport = (suspended) =>
      setDesktopLayoutState({
        phase: suspended ? "suspended" : "active",
        size: suspended ? { width: innerWidth, height: innerHeight } : null,
      });
  }, []);
  return (
    <QueryClientProvider client={client}>
      <ClientUiProvider host={host}>
        <button id="toggle" onClick={() => fixture.toggle()}>
          Toggle sidebar
        </button>
        <div id="theme">
          <ThemeMenu />
        </div>
        <span id="responsive-mode">{isPhone ? "phone" : isCompact ? "tablet" : "desktop"}</span>
        <div id="layout">
          <ResponsiveWorkbenchShell
            isMobile={isCompact}
            mobileSidebarOpen={false}
            sidebarCollapsed={collapsed}
            sidebarSize={sidebarSize}
            desktopSidebar={<div>Resources</div>}
            mobileSidebar={null}
            onCloseMobileSidebar={() => {}}
            onDesktopSidebarLayoutChange={(size) => {
              fixture.layoutWrites.push(size);
              setCollapsed(size < 1);
              if (size >= 1) setSidebarSize(size);
            }}
          >
            <div id="panes" hidden={!active}>
              <WorkbenchBrowser
                machineId="example"
                url={url}
                active={active}
                onUrlChange={() => {}}
              />
              {split && (
                <WorkbenchBrowser
                  machineId="example"
                  url={url}
                  active={active}
                  onUrlChange={() => {}}
                />
              )}
            </div>
          </ResponsiveWorkbenchShell>
        </div>
      </ClientUiProvider>
    </QueryClientProvider>
  );
}
root.render(<App />);
