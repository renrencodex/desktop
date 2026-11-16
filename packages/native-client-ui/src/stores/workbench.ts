import { create } from "zustand";

import type { MachineView } from "../lib/workbench-commands";

export const WORKBENCH_STORAGE_KEY = "cloud-machine.workbench.v1";
export const LEGACY_SIDEBAR_STORAGE_KEY = "cloud-machine.sidebar-collapsed";

export interface WorkbenchPreferences {
  version: 1;
  sidebarCollapsed: boolean;
  /** Desktop resource sidebar width as a percentage; null uses the 220px minimum. */
  sidebarSize: number | null;
  bottomPanelOpen: boolean;
  /** Machine bottom panel height as a percentage of the machine canvas. */
  bottomPanelSize: number;
  machineTabs: Record<string, MachineView>;
}

export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  version: 1,
  sidebarCollapsed: false,
  sidebarSize: null,
  bottomPanelOpen: false,
  bottomPanelSize: 32,
  machineTabs: {},
};

function isMachineView(value: unknown): value is MachineView {
  return ["overview", "ports", "snapshots"].includes(String(value));
}

export function clampWorkbenchSize(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function parseWorkbenchPreferences(
  raw: string | null,
  legacySidebarCollapsed: string | null = null,
): WorkbenchPreferences {
  if (raw) {
    try {
      const candidate = JSON.parse(raw) as Partial<WorkbenchPreferences>;
      if (candidate.version === 1) {
        return {
          version: 1,
          sidebarCollapsed:
            typeof candidate.sidebarCollapsed === "boolean"
              ? candidate.sidebarCollapsed
              : DEFAULT_WORKBENCH_PREFERENCES.sidebarCollapsed,
          sidebarSize:
            typeof candidate.sidebarSize === "number" && Number.isFinite(candidate.sidebarSize)
              ? clampWorkbenchSize(candidate.sidebarSize, 12, 36)
              : DEFAULT_WORKBENCH_PREFERENCES.sidebarSize,
          bottomPanelOpen:
            typeof candidate.bottomPanelOpen === "boolean"
              ? candidate.bottomPanelOpen
              : DEFAULT_WORKBENCH_PREFERENCES.bottomPanelOpen,
          bottomPanelSize:
            typeof candidate.bottomPanelSize === "number" &&
            Number.isFinite(candidate.bottomPanelSize)
              ? clampWorkbenchSize(candidate.bottomPanelSize, 18, 65)
              : DEFAULT_WORKBENCH_PREFERENCES.bottomPanelSize,
          machineTabs:
            candidate.machineTabs && typeof candidate.machineTabs === "object"
              ? Object.fromEntries(
                  Object.entries(candidate.machineTabs)
                    .filter(([machineId, view]) => machineId.length > 0 && isMachineView(view))
                    .slice(-20),
                )
              : {},
        };
      }
    } catch {
      // Invalid or stale local data falls through to safe defaults.
    }
  }

  return {
    ...DEFAULT_WORKBENCH_PREFERENCES,
    sidebarCollapsed:
      legacySidebarCollapsed === "true"
        ? true
        : legacySidebarCollapsed === "false"
          ? false
          : DEFAULT_WORKBENCH_PREFERENCES.sidebarCollapsed,
  };
}

function readPreferences(): WorkbenchPreferences {
  if (typeof window === "undefined") return DEFAULT_WORKBENCH_PREFERENCES;
  try {
    return parseWorkbenchPreferences(
      window.localStorage.getItem(WORKBENCH_STORAGE_KEY),
      window.localStorage.getItem(LEGACY_SIDEBAR_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_WORKBENCH_PREFERENCES;
  }
}

function writePreferences(preferences: WorkbenchPreferences): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(preferences));
    window.localStorage.removeItem(LEGACY_SIDEBAR_STORAGE_KEY);
  } catch {
    // Storage may be disabled; the current in-memory session still works.
  }
}

interface WorkbenchState extends WorkbenchPreferences {
  hydrated: boolean;
  mobileSidebarOpen: boolean;
  activeFilePath: string | null;
  openFileCount: number;
  dirtyFileCount: number;
  terminalCount: number;
  editorStatuses: Record<
    string,
    { activeFilePath: string | null; openFileCount: number; dirtyFileCount: number }
  >;
  terminalCounts: Record<string, number>;
  hydrate: () => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarSize: (size: number) => void;
  setMobileSidebarOpen: (open: boolean) => void;
  toggleBottomPanel: () => void;
  setBottomPanelOpen: (open: boolean) => void;
  setBottomPanelSize: (size: number) => void;
  setEditorStatus: (
    paneId: string,
    activeFilePath: string | null,
    openFileCount: number,
    dirtyFileCount?: number,
  ) => void;
  setTerminalCount: (paneId: string, count: number) => void;
  rememberMachineTab: (machineId: string, view: MachineView) => void;
}

function preferencesFromState(state: WorkbenchState): WorkbenchPreferences {
  return {
    version: 1,
    sidebarCollapsed: state.sidebarCollapsed,
    sidebarSize: state.sidebarSize,
    bottomPanelOpen: state.bottomPanelOpen,
    bottomPanelSize: state.bottomPanelSize,
    machineTabs: state.machineTabs,
  };
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  ...DEFAULT_WORKBENCH_PREFERENCES,
  hydrated: false,
  mobileSidebarOpen: false,
  activeFilePath: null,
  openFileCount: 0,
  dirtyFileCount: 0,
  terminalCount: 0,
  editorStatuses: {},
  terminalCounts: {},
  hydrate: () => {
    if (get().hydrated) return;
    set({ ...readPreferences(), hydrated: true });
  },
  toggleSidebar: () => get().setSidebarCollapsed(!get().sidebarCollapsed),
  setSidebarCollapsed: (sidebarCollapsed) => {
    set({ sidebarCollapsed });
    writePreferences(preferencesFromState(get()));
  },
  setSidebarSize: (size) => {
    set({ sidebarSize: clampWorkbenchSize(size, 12, 36) });
    writePreferences(preferencesFromState(get()));
  },
  setMobileSidebarOpen: (mobileSidebarOpen) => set({ mobileSidebarOpen }),
  toggleBottomPanel: () => get().setBottomPanelOpen(!get().bottomPanelOpen),
  setBottomPanelOpen: (bottomPanelOpen) => {
    set({ bottomPanelOpen });
    writePreferences(preferencesFromState(get()));
  },
  setBottomPanelSize: (size) => {
    set({ bottomPanelSize: clampWorkbenchSize(size, 18, 65) });
    writePreferences(preferencesFromState(get()));
  },
  setEditorStatus: (paneId, activeFilePath, openFileCount, dirtyFileCount = 0) => {
    const editorStatuses = { ...get().editorStatuses };
    if (openFileCount <= 0 && dirtyFileCount <= 0 && activeFilePath === null) {
      delete editorStatuses[paneId];
    } else {
      editorStatuses[paneId] = {
        activeFilePath,
        openFileCount: Math.max(0, openFileCount),
        dirtyFileCount: Math.max(0, dirtyFileCount),
      };
    }
    const statuses = Object.values(editorStatuses);
    set({
      editorStatuses,
      activeFilePath:
        activeFilePath ??
        [...statuses].reverse().find((status) => status.activeFilePath)?.activeFilePath ??
        null,
      openFileCount: statuses.reduce((sum, status) => sum + status.openFileCount, 0),
      dirtyFileCount: statuses.reduce((sum, status) => sum + status.dirtyFileCount, 0),
    });
  },
  setTerminalCount: (paneId, count) => {
    const terminalCounts = { ...get().terminalCounts };
    if (count <= 0) delete terminalCounts[paneId];
    else terminalCounts[paneId] = Math.max(0, count);
    set({
      terminalCounts,
      terminalCount: Object.values(terminalCounts).reduce((sum, value) => sum + value, 0),
    });
  },
  rememberMachineTab: (machineId, view) => {
    const current = get().machineTabs;
    const machineTabs = Object.fromEntries(
      [...Object.entries(current).filter(([id]) => id !== machineId), [machineId, view]].slice(-20),
    ) as Record<string, MachineView>;
    set({ machineTabs });
    writePreferences(preferencesFromState(get()));
  },
}));
