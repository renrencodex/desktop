"use client";

import { createContext, useContext } from "react";
import type { WorkspaceShellModel } from "@cloud-machine/workspace-ui";
import type { WorkspaceProtection } from "../lib/workspace-cache";

export type WorkspaceResource = WorkspaceProtection;
export interface WorkbenchRuntime extends WorkspaceShellModel {
  report: (key: string, value: WorkspaceResource | null) => void;
  evict: (key: string) => void;
  navigateCached: (href: string, replace?: boolean) => boolean;
  restoreCached: (href: string, replace?: boolean) => boolean;
  recent: { href: string; label: string }[];
}
export const RuntimeContext = createContext<WorkbenchRuntime | null>(null);
export const useWorkbenchRuntime = () => useContext(RuntimeContext);
