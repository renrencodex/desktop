export const CLIENT_PERFORMANCE_MEASURES = {
  workspaceLayoutReady: "renrencodex.workspace.layout-ready",
  workspaceInteractive: "renrencodex.workspace.interactive",
  applicationsReady: "renrencodex.applications.ready",
  terminalRendererReady: "renrencodex.terminal.renderer-ready",
  terminalTicketReady: "renrencodex.terminal.ticket-ready",
  terminalSocketOpen: "renrencodex.terminal.socket-open",
  terminalOpened: "renrencodex.terminal.opened",
  terminalInteractive: "renrencodex.terminal.interactive",
} as const;

export type ClientPerformanceMeasure =
  (typeof CLIENT_PERFORMANCE_MEASURES)[keyof typeof CLIENT_PERFORMANCE_MEASURES];
export type ClientPerformanceKind = "web" | "tauri-desktop" | "tauri-mobile";
export type ClientPerformanceTemperature = "cold" | "warm";

export interface ClientPerformanceDetail {
  client: ClientPerformanceKind;
  temperature: ClientPerformanceTemperature;
  outcome: "success" | "error";
}

interface WorkspaceNavigationAttempt {
  startedAt: number;
  detail: Omit<ClientPerformanceDetail, "outcome">;
  measured: Set<ClientPerformanceMeasure>;
}

const workspaceAttempts = new Map<string, WorkspaceNavigationAttempt>();
const MAX_WORKSPACE_ATTEMPTS = 50;

export function clientPerformanceNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * Records an in-memory User Timing measure. Detail is deliberately a closed, identifier-free
 * shape so a benchmark cannot accidentally retain account, machine, workspace or terminal data.
 */
export function recordClientPerformance(
  name: ClientPerformanceMeasure,
  startedAt: number,
  detail: ClientPerformanceDetail,
): number {
  const endedAt = clientPerformanceNow();
  const duration = Math.max(0, endedAt - startedAt);
  const timing = globalThis.performance;
  if (!timing?.measure) return duration;
  try {
    timing.measure(name, { start: startedAt, end: endedAt, detail });
  } catch {
    // Older WebViews may not support PerformanceMeasureOptions.detail. Timing must never block UI.
    try {
      timing.measure(name, { start: startedAt, end: endedAt });
    } catch {
      // Unsupported User Timing implementations remain functional without diagnostics.
    }
  }
  return duration;
}

export function beginWorkspaceNavigation(
  workspaceKey: string,
  detail: Omit<ClientPerformanceDetail, "outcome">,
): void {
  if (workspaceAttempts.size >= MAX_WORKSPACE_ATTEMPTS && !workspaceAttempts.has(workspaceKey)) {
    const oldest = workspaceAttempts.keys().next().value;
    if (oldest !== undefined) workspaceAttempts.delete(oldest);
  }
  workspaceAttempts.set(workspaceKey, {
    startedAt: clientPerformanceNow(),
    detail,
    measured: new Set(),
  });
}

export function ensureWorkspaceNavigation(
  workspaceKey: string,
  detail: Omit<ClientPerformanceDetail, "outcome">,
): void {
  if (!workspaceAttempts.has(workspaceKey)) beginWorkspaceNavigation(workspaceKey, detail);
}

export function recordWorkspaceNavigation(
  workspaceKey: string,
  name:
    | typeof CLIENT_PERFORMANCE_MEASURES.workspaceLayoutReady
    | typeof CLIENT_PERFORMANCE_MEASURES.workspaceInteractive
    | typeof CLIENT_PERFORMANCE_MEASURES.applicationsReady,
  outcome: ClientPerformanceDetail["outcome"] = "success",
): number | null {
  const attempt = workspaceAttempts.get(workspaceKey);
  if (!attempt || attempt.measured.has(name)) return null;
  attempt.measured.add(name);
  return recordClientPerformance(name, attempt.startedAt, { ...attempt.detail, outcome });
}

/** Test/account-boundary cleanup; no timing state may survive an authenticated shell owner. */
export function clearWorkspaceNavigationPerformance(): void {
  workspaceAttempts.clear();
}
