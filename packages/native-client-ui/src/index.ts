"use client";

export {
  ClientUiProvider,
  Link,
  gatewayWebSocketUrl,
  getClientHost,
  useClientHost,
  usePathname,
  useRouter,
  useSearchParams,
  type ClientHostConfig,
  type ClientLocation,
  type ClientSession,
  type LinkProps,
} from "./host";
export { AuthedLayout } from "./components/AppLayout";
export { ClientRouteOutlet, parseClientRoute, type ClientRouteMatch } from "./routes";
export { initializeTheme, useThemeStore } from "./stores/theme";
export { useAuthStore } from "./stores/auth";
export { useWorkbenchStore } from "./stores/workbench";
export { Toaster } from "./components/Toaster";
export { BrandLogo } from "./components/BrandLogo";
export { DesktopUpdateProvider, useDesktopUpdate } from "./components/DesktopUpdateProvider";
export { createNativeThemeSync } from "./lib/native-theme";
export { machineMetricsCache } from "./lib/machine-metrics-cache";
export { useVisualViewportHeight } from "./lib/responsive";
export { DashboardPage } from "./views/DashboardPage";
export { MachineDetailPage } from "./views/MachineDetailPage";
export { MachineProvisioningPage } from "./views/MachineProvisioningPage";
export { NewMachinePage } from "./views/NewMachinePage";
export { SettingsPage } from "./views/SettingsPage";
