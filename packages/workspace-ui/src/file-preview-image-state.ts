import type { PreviewResourceIssue } from "./file-preview-policy";

export const IMAGE_RETRY_COOLDOWN_MS = 5_000;
export const IMAGE_RETRY_TIMEOUT_MS = 30_000;

/** Wait for a performance.now() deadline, rescheduling if a timer fires early. */
export function scheduleImageDeadline(deadline: number, onElapsed: (now: number) => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    if (stopped) return;
    const now = performance.now();
    const remaining = deadline - now;
    if (remaining > 0) {
      timer = setTimeout(check, Math.ceil(remaining));
    } else {
      stopped = true;
      onElapsed(now);
    }
  };
  check();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

export type ExternalImageAttempt =
  | { id: number; status: "loaded" }
  | { id: number; status: "failed" | "retrying"; issue: PreviewResourceIssue };

export interface PreviewImageState {
  active: boolean;
  generation: number;
  attempts: ReadonlyMap<string, ExternalImageAttempt>;
  /** Monotonic performance.now() deadlines, never wall-clock timestamps. */
  retryAvailableAt: number | null;
  retryDeadline: number | null;
}

type ImageAction =
  | { type: "active"; active: boolean }
  | {
      type: "settled";
      generation: number;
      url: string;
      attempt: number;
      outcome: "loaded" | "failed";
    }
  | { type: "retry" | "tick"; generation: number; now: number };

export function createImageState(active: boolean): PreviewImageState {
  return {
    active,
    generation: 0,
    attempts: new Map(),
    retryAvailableAt: null,
    retryDeadline: null,
  };
}

function failure(url: string, timeout = false): PreviewResourceIssue {
  return {
    reference: url,
    kind: "external-load-failed",
    message: timeout
      ? "重试超时（30 秒），请稍后重试。"
      : "图片未能显示，可能是网络异常、站点限制或图片内容无效。请稍后重试。",
  };
}

/** Per-preview state only. Deadlines change UI state; they never start network requests. */
export function reduceImageState(state: PreviewImageState, action: ImageAction): PreviewImageState {
  if (action.type === "active")
    return state.active === action.active
      ? state
      : { ...createImageState(action.active), generation: state.generation + 1 };
  if (!state.active || action.generation !== state.generation) return state;

  if (action.type === "settled") {
    const previous = state.attempts.get(action.url);
    // Accept only the first terminal result of the current attempt, including duplicate URLs.
    if ((previous?.id ?? 0) !== action.attempt || (previous && previous.status !== "retrying"))
      return state;
    const attempts = new Map(state.attempts);
    attempts.set(
      action.url,
      action.outcome === "loaded"
        ? { id: action.attempt, status: "loaded" }
        : { id: action.attempt, status: "failed", issue: failure(action.url) },
    );
    return {
      ...state,
      attempts,
      retryDeadline: [...attempts.values()].some((attempt) => attempt.status === "retrying")
        ? state.retryDeadline
        : null,
    };
  }

  if (action.type === "retry") {
    if (
      state.retryDeadline !== null ||
      (state.retryAvailableAt !== null && action.now < state.retryAvailableAt)
    )
      return state;
    const attempts = new Map(state.attempts);
    let changed = false;
    for (const [url, attempt] of attempts) {
      if (attempt.status !== "failed") continue;
      attempts.set(url, { ...attempt, id: attempt.id + 1, status: "retrying" });
      changed = true;
    }
    return changed
      ? {
          ...state,
          attempts,
          retryAvailableAt: action.now + IMAGE_RETRY_COOLDOWN_MS,
          retryDeadline: action.now + IMAGE_RETRY_TIMEOUT_MS,
        }
      : state;
  }

  const retryAvailableAt =
    state.retryAvailableAt !== null && action.now >= state.retryAvailableAt
      ? null
      : state.retryAvailableAt;
  if (state.retryDeadline !== null && action.now >= state.retryDeadline) {
    const attempts = new Map(state.attempts);
    for (const [url, attempt] of attempts) {
      if (attempt.status === "retrying")
        attempts.set(url, { ...attempt, status: "failed", issue: failure(url, true) });
    }
    return { ...state, attempts, retryAvailableAt, retryDeadline: null };
  }
  return retryAvailableAt === state.retryAvailableAt ? state : { ...state, retryAvailableAt };
}
