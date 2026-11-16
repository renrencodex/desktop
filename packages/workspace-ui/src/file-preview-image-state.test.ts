import { expect, jest, spyOn, test } from "bun:test";
import {
  createImageState,
  IMAGE_RETRY_COOLDOWN_MS,
  IMAGE_RETRY_TIMEOUT_MS,
  reduceImageState as reduce,
  scheduleImageDeadline,
  type PreviewImageState,
} from "./file-preview-image-state";

const url = "https://images.example.com/chart.svg?theme=dark#left";
const right = "https://images.example.com/chart.svg?theme=dark#right";
const settled = (
  state: PreviewImageState,
  outcome: "loaded" | "failed",
  reference = url,
  attempt = state.attempts.get(reference)?.id ?? 0,
  generation = state.generation,
) => reduce(state, { type: "settled", generation, url: reference, attempt, outcome });
const retry = (state: PreviewImageState, now = 100) =>
  reduce(state, { type: "retry", generation: state.generation, now });
const tick = (state: PreviewImageState, now: number) =>
  reduce(state, { type: "tick", generation: state.generation, now });
const activeState = () => createImageState(true);

test("定时器提前触发时按剩余时间重新调度，到期只通知一次", () => {
  jest.useFakeTimers();
  let now = 100;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const elapsed: number[] = [];
  const cancel = scheduleImageDeadline(105.5, (time) => elapsed.push(time));
  try {
    jest.advanceTimersByTime(6);
    expect(elapsed).toEqual([]);
    now = 105.25;
    jest.advanceTimersByTime(6);
    expect(elapsed).toEqual([]);
    now = 105.5;
    jest.advanceTimersByTime(1);
    expect(elapsed).toEqual([105.5]);
    jest.advanceTimersByTime(60_000);
    expect(elapsed).toEqual([105.5]);
  } finally {
    cancel();
    clock.mockRestore();
    jest.useRealTimers();
  }
});

test("取消时清除提前触发后新建的计时器，不通知已失活预览", () => {
  jest.useFakeTimers();
  const clock = spyOn(performance, "now").mockReturnValue(100);
  let calls = 0;
  const cancel = scheduleImageDeadline(200, () => calls++);
  try {
    jest.advanceTimersByTime(100);
    expect(calls).toBe(0);
    cancel();
    clock.mockReturnValue(300);
    jest.advanceTimersByTime(60_000);
    expect(calls).toBe(0);
  } finally {
    cancel();
    clock.mockRestore();
    jest.useRealTimers();
  }
});

test("调度已经到期的期限立即通知，不再安排计时器", () => {
  jest.useFakeTimers();
  const elapsed: number[] = [];
  const deadline = performance.now() - 1;
  const cancel = scheduleImageDeadline(deadline, (time) => elapsed.push(time));
  try {
    expect(elapsed).toHaveLength(1);
    expect(elapsed[0]!).toBeGreaterThanOrEqual(deadline);
    jest.advanceTimersByTime(60_000);
    expect(elapsed).toHaveLength(1);
  } finally {
    cancel();
    jest.useRealTimers();
  }
});

test("活动预览默认接受图片结果，失活时忽略重试和图片回调", () => {
  const inactive = createImageState(false);
  expect(retry(inactive)).toBe(inactive);
  expect(settled(inactive, "failed")).toBe(inactive);
  expect(settled(inactive, "loaded")).toBe(inactive);
  const active = activeState();
  expect(retry(active)).toBe(active);
  expect(settled(active, "failed").attempts.get(url)?.status).toBe("failed");
  expect(settled(active, "loaded").attempts.get(url)?.status).toBe("loaded");
});

test("失败按完整地址去重，重试保留查询/片段且不触及成功图片", () => {
  let state = settled(activeState(), "loaded", right);
  state = settled(state, "failed");
  const successful = state.attempts.get(right);
  expect(settled(state, "failed")).toBe(state);
  expect(state.attempts.size).toBe(2);
  const original = state;
  state = retry(state);
  expect([...state.attempts.keys()]).toEqual([right, url]);
  expect(state.attempts.get(right)).toBe(successful);
  expect(state.attempts.get(url)?.status).toBe("retrying");
  expect(state.attempts.get(url)?.id).toBe(1);
  expect(original.attempts.get(url)?.status).toBe("failed");
  expect(state.retryAvailableAt).toBe(100 + IMAGE_RETRY_COOLDOWN_MS);
  expect(state.retryDeadline).toBe(100 + IMAGE_RETRY_TIMEOUT_MS);
  // Both a duplicate click and a click after cooldown are ignored while the batch is pending.
  expect(retry(state)).toBe(state);
  expect(retry(state, 10_000)).toBe(state);
});

test("成功清除对应错误，旧尝试及重复节点的迟到结果不能污染当前尝试", () => {
  let state = retry(settled(activeState(), "failed"));
  expect(settled(state, "loaded", url, 0)).toBe(state);
  expect(settled(state, "failed", url, 0)).toBe(state);
  state = settled(state, "loaded");
  expect(state.attempts.get(url)).toEqual({ id: 1, status: "loaded" });
  expect(state.retryDeadline).toBeNull();
  expect(settled(state, "failed")).toBe(state);
  expect(settled(state, "loaded")).toBe(state);
  expect(retry(tick(state, 50_000), 50_000).attempts.get(url)?.id).toBe(1);
});

test("立即再失败保留错误，五秒前不能再次请求，计时不会自动重试", () => {
  let state = retry(settled(activeState(), "failed"));
  state = settled(state, "failed");
  expect(state.retryDeadline).toBeNull();
  expect(retry(state, 100 + IMAGE_RETRY_COOLDOWN_MS - 1)).toBe(state);
  state = tick(state, 100 + IMAGE_RETRY_COOLDOWN_MS);
  expect(state.retryAvailableAt).toBeNull();
  expect(state.attempts.get(url)?.status).toBe("failed");
  expect(state.attempts.get(url)?.id).toBe(1);
  state = retry(state, 100 + IMAGE_RETRY_COOLDOWN_MS);
  expect(state.attempts.get(url)?.id).toBe(2);
  expect(settled(state, "failed", url, 1)).toBe(state);
});

test("批量重试逐项完成，三十秒只将仍等待的图片标为超时", () => {
  let state = settled(settled(activeState(), "failed"), "failed", right);
  state = retry(state);
  state = settled(state, "loaded");
  const deadline = state.retryDeadline!;
  expect(deadline).toBe(100 + IMAGE_RETRY_TIMEOUT_MS);
  state = tick(state, deadline - 1);
  expect(state.attempts.get(right)?.status).toBe("retrying");
  state = tick(state, deadline);
  expect(state.retryDeadline).toBeNull();
  expect(state.retryAvailableAt).toBeNull();
  expect(state.attempts.get(url)).toEqual({ id: 1, status: "loaded" });
  const timeout = state.attempts.get(right)!;
  expect(timeout.status).toBe("failed");
  expect("issue" in timeout && timeout.issue.message).toContain("重试超时");
  expect(settled(state, "loaded", right)).toBe(state);
  state = retry(state, deadline + 1);
  expect(state.attempts.get(right)?.id).toBe(2);
  expect(state.attempts.get(url)?.id).toBe(1);
});

test("重试期间新出现的失败留到下次手动重试，不加入当前批次", () => {
  let state = retry(settled(activeState(), "failed"));
  state = settled(state, "failed", right);
  expect(state.attempts.get(right)?.status).toBe("failed");
  state = settled(state, "loaded");
  expect(state.retryDeadline).toBeNull();
  state = retry(tick(state, 6_000), 6_000);
  expect(state.attempts.get(right)?.status).toBe("retrying");
  expect(state.attempts.get(url)?.status).toBe("loaded");
});

test("失活清空错误和期限，重新激活自动加载且旧回调不能越过活动代次", () => {
  let state = retry(settled(activeState(), "failed"));
  state = reduce(state, { type: "active", active: false });
  expect(state).toEqual({ ...createImageState(false), generation: 1 });
  state = reduce(state, { type: "active", active: true });
  expect(state).toEqual({ ...createImageState(true), generation: 2 });
  expect(settled(state, "failed", url, 1, 0)).toBe(state);
  expect(reduce(state, { type: "retry", generation: 0, now: 40_000 })).toBe(state);
  expect(reduce(state, { type: "tick", generation: 0, now: 40_000 })).toBe(state);
  state = retry(settled(state, "failed"), 40_000);
  expect(state.attempts.get(url)?.id).toBe(1);
  expect(reduce(state, { type: "tick", generation: 0, now: 80_000 })).toBe(state);
});
