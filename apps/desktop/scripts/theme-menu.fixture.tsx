import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeMenu } from "@cloud-machine/native-client-ui/components/ThemeMenu";
import { initializeTheme, useThemeStore } from "@cloud-machine/native-client-ui/stores/theme";
import { nativePreviewOcclusionStore } from "@cloud-machine/native-client-ui/lib/native-preview-occlusion";

initializeTheme();
const changes: string[] = [];
useThemeStore.subscribe((state) => changes.push(state.themeId));
const root = createRoot(document.getElementById("root")!);
window.themeMenuFixture = {
  changes,
  blocked: () => nativePreviewOcclusionStore.getState().blockers.size > 0,
  unmount: () => root.unmount(),
};
declare global {
  interface Window {
    themeMenuFixture: { changes: string[]; blocked(): boolean; unmount(): void };
  }
}
root.render(
  <StrictMode>
    <div style={{ position: "fixed", right: 32, top: 32 }}>
      <ThemeMenu />
    </div>
  </StrictMode>,
);
