"use client";

import { useEffect } from "react";

import type { SettingsSection } from "./lib/settings";
import { usePathname, useRouter } from "./host";
import { DashboardPage } from "./views/DashboardPage";
import { MachineDetailPage } from "./views/MachineDetailPage";
import { MachineProvisioningPage } from "./views/MachineProvisioningPage";
import { NewMachinePage } from "./views/NewMachinePage";
import { SettingsPage } from "./views/SettingsPage";

export type ClientRouteMatch =
  | { kind: "redirect"; to: string }
  | { kind: "machines" }
  | { kind: "new-machine" }
  | { kind: "machine"; machineId: string }
  | { kind: "provisioning"; machineId: string }
  | { kind: "workspace" }
  | { kind: "settings"; section: SettingsSection }
  | { kind: "not-found" };

const SETTINGS_SECTIONS = new Set<SettingsSection>([
  "account",
  "about",
  "notifications",
  "orders",
  "referrals",
  "wallet",
]);

function safeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function parseClientRoute(pathname: string): ClientRouteMatch {
  if (pathname === "/") return { kind: "redirect", to: "/machines" };
  if (pathname === "/machines" || pathname === "/machines/") return { kind: "machines" };
  if (pathname === "/machines/new" || pathname === "/machines/new/") {
    return { kind: "new-machine" };
  }

  const provisioning = pathname.match(/^\/machines\/([^/]+)\/provisioning\/?$/);
  if (provisioning) {
    const machineId = safeSegment(provisioning[1] ?? "");
    return machineId ? { kind: "provisioning", machineId } : { kind: "not-found" };
  }

  const legacyDirectory = pathname.match(
    /^\/machines\/([^/]+)\/workspaces\/([^/]+)\/directories\/([^/]+)\/?$/,
  );
  if (legacyDirectory) {
    const machineId = legacyDirectory[1];
    const directoryId = legacyDirectory[3];
    return machineId && directoryId
      ? { kind: "redirect", to: `/machines/${machineId}/workspaces/${directoryId}` }
      : { kind: "not-found" };
  }

  if (/^\/machines\/[^/]+\/workspaces\/[^/]+\/?$/.test(pathname)) {
    return { kind: "workspace" };
  }

  const machine = pathname.match(/^\/machines\/([^/]+)\/?$/);
  if (machine) {
    const machineId = safeSegment(machine[1] ?? "");
    return machineId ? { kind: "machine", machineId } : { kind: "not-found" };
  }

  if (pathname === "/settings" || pathname === "/settings/") {
    return { kind: "settings", section: "account" };
  }
  if (pathname === "/settings/models" || pathname === "/settings/models/") {
    return { kind: "redirect", to: "/settings" };
  }
  const settings = pathname.match(/^\/settings\/([^/]+)\/?$/);
  if (settings && SETTINGS_SECTIONS.has(settings[1] as SettingsSection)) {
    return { kind: "settings", section: settings[1] as SettingsSection };
  }
  return { kind: "not-found" };
}

function Navigate({ to }: { to: string }) {
  const router = useRouter();
  useEffect(() => router.replace(to), [router, to]);
  return null;
}

function NotFound() {
  const router = useRouter();
  return (
    <main className="cm-canvas flex h-full items-center justify-center p-6">
      <section className="cm-panel max-w-sm p-6 text-center">
        <h1 className="text-base font-semibold text-zinc-100">页面不存在</h1>
        <p className="mt-2 text-xs leading-5 text-zinc-500">请返回计算资源页重新选择电脑或项目。</p>
        <button
          className="cm-button-primary mt-4 h-8 px-3 text-xs"
          onClick={() => router.replace("/machines")}
        >
          返回计算资源
        </button>
      </section>
    </main>
  );
}

export function ClientRouteOutlet() {
  const route = parseClientRoute(usePathname());
  switch (route.kind) {
    case "redirect":
      return <Navigate to={route.to} />;
    case "machines":
      return <DashboardPage />;
    case "new-machine":
      return <NewMachinePage />;
    case "machine":
      return <MachineDetailPage machineId={route.machineId} />;
    case "provisioning":
      return <MachineProvisioningPage machineId={route.machineId} />;
    case "workspace":
      return null;
    case "settings":
      return <SettingsPage section={route.section} />;
    case "not-found":
      return <NotFound />;
  }
}
