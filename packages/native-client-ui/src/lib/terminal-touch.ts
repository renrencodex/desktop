/**
 * ghostty-web 0.4 只处理 wheel，canvas 上没有 touchmove，触屏拖动既不滚动终端也
 * 不滚动页面。按帧累计单指纵向位移，本地直接翻看历史，TUI 翻译为既有鼠标链路，
 * 并提供有界的短惯性；输入与连接生命周期可以同步取消尚未发送的滚动。
 */
const SCROLL_THRESHOLD_PX = 6;
/** 超过这个位移就不再是轻点：既不聚焦，也不向 TUI 报告鼠标点击。 */
const TAP_SLOP_PX = 10;
const DEFAULT_LINE_HEIGHT_PX = 20;
const LONG_PRESS_DELAY_MS = 450;

export interface TouchScrollPoint {
  x: number;
  y: number;
}

export interface TouchScrollGesture {
  readonly identifier: number;
  readonly origin: TouchScrollPoint;
  readonly last: TouchScrollPoint;
  /** 尚未凑满一整行的像素位移。 */
  readonly remainder: number;
  readonly scrolling: boolean;
  /** 任意方向的位移已经超过轻点容差，不能再当作点击。 */
  readonly moved: boolean;
}

export function beginTouchScroll(identifier: number, point: TouchScrollPoint): TouchScrollGesture {
  return { identifier, origin: point, last: point, remainder: 0, scrolling: false, moved: false };
}

/**
 * 纵向拖动才接管，横向拖动与多指手势留给浏览器。滚动量取整到整行：TUI 与 ghostty
 * 的 wheel 处理都按整行推进，半行像素留到下一次移动，保持跟手且不丢位移。
 */
export function advanceTouchScroll(
  gesture: TouchScrollGesture,
  point: TouchScrollPoint,
  lineHeight: number,
): { gesture: TouchScrollGesture; deltaY: number } {
  const travelY = point.y - gesture.origin.y;
  const travelX = point.x - gesture.origin.x;
  // 斜向与横向拖动不接管滚动，但同样不是轻点：记下来，touchend 才能拦掉聚焦和点击。
  const moved = gesture.moved || Math.abs(travelY) > TAP_SLOP_PX || Math.abs(travelX) > TAP_SLOP_PX;
  if (!gesture.scrolling) {
    if (Math.abs(travelY) < SCROLL_THRESHOLD_PX || Math.abs(travelY) <= Math.abs(travelX))
      return { gesture: { ...gesture, last: point, moved }, deltaY: 0 };
  }
  const height = lineHeight > 0 ? lineHeight : DEFAULT_LINE_HEIGHT_PX;
  const travel = gesture.scrolling ? gesture.remainder + (point.y - gesture.last.y) : travelY;
  const lines = Math.trunc(travel / height);
  return {
    gesture: {
      ...gesture,
      last: point,
      remainder: travel - lines * height,
      scrolling: true,
      moved: true,
    },
    // 手指下移 = 回看更早的历史，与滚轮上滚（deltaY 为负）方向一致。
    deltaY: lines === 0 ? 0 : -lines * height,
  };
}

const touchScrollWheels = new WeakSet<Event>();

/**
 * 触屏合成的滚轮事件按整行推进，不应再被高分辨率触控板的降敏逻辑缩小。
 * 见 terminal-mouse 的 wheel 处理。
 */
export function markTouchScrollWheel(event: Event): void {
  touchScrollWheels.add(event);
}

export function isTouchScrollWheel(event: Event): boolean {
  return touchScrollWheels.has(event);
}

export function attachTerminalTouchScroll(
  container: HTMLElement,
  getLineHeight: () => number | undefined,
  options: {
    /** 返回 false 表示到达本地历史边界；undefined 交给后端鼠标上报。 */
    scroll?: (lines: number) => boolean | undefined;
    getMode?: () => string;
    /** xterm 的鼠标 wheel 链路每个事件只上报一步。 */
    singleLineWheel?: boolean;
    /** Canvas 没有原生文本节点，长按后由渲染器维护本地选区。 */
    selection?: {
      isActive(): boolean;
      isRangeSelectionArmed(): boolean;
      begin(point: TouchScrollPoint): boolean;
      beginHandleDrag?(point: TouchScrollPoint): boolean;
      beginRange(point: TouchScrollPoint): boolean;
      update(point: TouchScrollPoint): void;
      end(): void;
      clear(): void;
    };
    onBlankLongPress?: (point: TouchScrollPoint) => void;
    /** 仅供确定性单元测试缩短计时；产品行为固定为 450ms。 */
    longPressDelayMs?: number;
  } = {},
): { cancel(): void; setEnabled(value: boolean): void; dispose(): void } {
  const view = container.ownerDocument.defaultView;
  if (!view) return { cancel() {}, setEnabled() {}, dispose() {} };
  let gesture: TouchScrollGesture | null = null;
  let enabled = true;
  let dragged = false;
  let frame = 0;
  let pending = 0;
  let velocity = 0;
  let lastFrame = 0;
  let releasedAt = 0;
  let direction = 0;
  let mode: string | undefined;
  let point: TouchScrollPoint = { x: 0, y: 0 };
  let target: EventTarget | null = null;
  let samples: { time: number; y: number }[] = [];
  let longPressTimer = 0;
  let selecting = false;
  let lastTouchAt = Number.NEGATIVE_INFINITY;
  const height = () => {
    const value = getLineHeight();
    return value && Number.isFinite(value) && value > 0 ? value : DEFAULT_LINE_HEIGHT_PX;
  };
  const cancelLongPress = () => {
    if (longPressTimer) view.clearTimeout(longPressTimer);
    longPressTimer = 0;
  };
  const cancel = () => {
    cancelLongPress();
    if (frame) view.cancelAnimationFrame(frame);
    frame = 0;
    pending = velocity = direction = 0;
    gesture = null;
    samples = [];
    if (selecting) options.selection?.end();
    selecting = false;
  };

  const dispatchWheel = (deltaY: number, deltaMode = 0) => {
    const element =
      target instanceof view.Element && container.contains(target) ? target : container;
    const wheel = new view.WheelEvent("wheel", {
      deltaY,
      deltaMode,
      clientX: point.x,
      clientY: point.y,
      bubbles: true,
      cancelable: true,
      view,
    });
    markTouchScrollWheel(wheel);
    element.dispatchEvent(wheel);
  };
  const schedule = () => {
    if (!frame) frame = view.requestAnimationFrame(flush);
  };
  const flush = (now: number) => {
    frame = 0;
    if (!enabled || mode !== options.getMode?.()) {
      cancel();
      return;
    }
    if (velocity) {
      const elapsed = Math.max(0, Math.min(now - lastFrame, 600 - (lastFrame - releasedAt)));
      const speed = Math.abs(velocity);
      const duration = Math.min(elapsed, speed / 0.004);
      pending += Math.sign(velocity) * (speed * duration - 0.002 * duration * duration);
      velocity =
        now - releasedAt >= 600 ? 0 : Math.sign(velocity) * Math.max(0, speed - 0.004 * elapsed);
      lastFrame = now;
    }
    const lineHeight = height();
    const lines = Math.max(-8, Math.min(8, Math.trunc(pending / lineHeight)));
    if (lines) {
      pending -= lines * lineHeight;
      const handled = options.scroll?.(lines);
      if (handled === false) {
        // 到边界只停止位移和惯性。手指仍按着时保留跟踪，允许直接反向拖动。
        pending = velocity = direction = 0;
        samples = [];
        if (gesture) gesture = { ...gesture, remainder: 0 };
        return;
      }
      if (handled === undefined) {
        if (options.singleLineWheel) {
          // 行单位避开 xterm 对小像素 wheel 的触控板降敏。
          for (let i = 0; i < Math.abs(lines); i++) dispatchWheel(Math.sign(lines), 1);
        } else dispatchWheel(lines * lineHeight);
      }
    }
    if (velocity || Math.abs(pending) >= lineHeight) schedule();
  };

  const onTouchStart = (event: TouchEvent) => {
    lastTouchAt = view.performance.now();
    const touch = event.touches[0];
    if (enabled && event.touches.length === 1 && touch) {
      const handlePoint = { x: touch.clientX, y: touch.clientY };
      if (options.selection?.beginHandleDrag?.(handlePoint)) {
        cancel();
        point = handlePoint;
        mode = options.getMode?.();
        gesture = beginTouchScroll(touch.identifier, point);
        selecting = true;
        dragged = true;
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }
    const rangeSelectionArmed = options.selection?.isRangeSelectionArmed() === true;
    if (options.selection?.isActive() && !rangeSelectionArmed) options.selection.clear();
    cancel();
    dragged = false;
    // 捏合缩放等多指手势保持浏览器默认行为。
    if (!enabled || event.touches.length !== 1) return;
    const primaryTouch = event.touches[0]!;
    point = { x: primaryTouch.clientX, y: primaryTouch.clientY };
    target = event.target;
    mode = options.getMode?.();
    samples = [{ time: view.performance.now(), y: point.y }];
    gesture = beginTouchScroll(primaryTouch.identifier, point);
    if (rangeSelectionArmed) {
      selecting = options.selection?.beginRange(point) === true;
      if (selecting) {
        dragged = true;
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
      }
      return;
    }
    longPressTimer = view.setTimeout(() => {
      longPressTimer = 0;
      if (!enabled || !gesture || gesture.moved || mode !== options.getMode?.()) return;
      selecting = options.selection?.begin(point) === true;
      if (selecting) {
        pending = velocity = direction = 0;
        dragged = true;
      } else if (options.onBlankLongPress) {
        dragged = true;
        options.onBlankLongPress(point);
      }
    }, options.longPressDelayMs ?? LONG_PRESS_DELAY_MS);
  };

  const onTouchMove = (event: TouchEvent) => {
    const current = gesture;
    if (!current) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || !touch || touch.identifier !== current.identifier) {
      if (selecting) options.selection?.clear();
      cancel();
      return;
    }
    if (mode !== options.getMode?.()) {
      cancel();
      return;
    }
    point = { x: touch.clientX, y: touch.clientY };
    if (selecting) {
      options.selection?.update(point);
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const now = view.performance.now();
    const nextDirection = Math.sign(point.y - current.last.y);
    const reversed = nextDirection && direction && nextDirection !== direction;
    if (reversed) {
      pending = 0;
      samples = [{ time: now, y: current.last.y }];
    }
    if (nextDirection) direction = nextDirection;
    samples = samples.filter((sample) => now - sample.time <= 80);
    samples.push({ time: now, y: point.y });
    const advanced = advanceTouchScroll(
      reversed ? { ...current, remainder: 0 } : current,
      point,
      height(),
    );
    gesture = advanced.gesture;
    dragged ||= gesture.moved || gesture.scrolling;
    if (gesture.moved || gesture.scrolling) cancelLongPress();
    if (!advanced.gesture.scrolling) return;
    // 接管纵向手势，避免浏览器把它当作页面滚动或下拉刷新。
    if (event.cancelable) event.preventDefault();
    pending += advanced.deltaY;
    if (pending) schedule();
  };

  const onTouchEnd = (event: TouchEvent) => {
    cancelLongPress();
    if (selecting) {
      selecting = false;
      gesture = null;
      samples = [];
      options.selection?.end();
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const now = view.performance.now();
    const recent = samples.filter((sample) => now - sample.time <= 80);
    const first = recent[0];
    const last = recent.at(-1);
    if (
      gesture?.scrolling &&
      first &&
      last &&
      now > first.time &&
      !view.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      velocity = Math.max(-2, Math.min(2, -(last.y - first.y) / (now - first.time)));
      // 保留尚不足一行的手指位移，惯性阶段继续累计。
      pending -= gesture.remainder;
      releasedAt = lastFrame = now;
      if (velocity) schedule();
    }
    gesture = null;
    if (!dragged) return;
    // ghostty 在 canvas 的 touchend 里聚焦隐藏输入框，浏览器随后还会补发
    // mousedown/click（terminal-mouse 会当成 TUI 点击上报）。拖动过的手势两者都不要。
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onTouchCancel = () => {
    if (selecting || options.selection?.isActive()) options.selection?.clear();
    cancel();
  };

  const onContextMenu = (event: MouseEvent) => {
    const eventTarget = event.target;
    if (!(eventTarget instanceof view.Node) || !container.contains(eventTarget)) return;
    if (!options.selection?.isActive() && view.performance.now() - lastTouchAt > 1_000) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const listenerOptions = { capture: true, passive: false };
  container.addEventListener("touchstart", onTouchStart, listenerOptions);
  container.addEventListener("touchmove", onTouchMove, listenerOptions);
  container.addEventListener("touchend", onTouchEnd, listenerOptions);
  container.addEventListener("touchcancel", onTouchCancel, listenerOptions);
  // Radix 的 React 委托监听先于终端挂到 document；必须在更外层的 window 捕获阶段
  // 拦截触摸长按合成的 contextmenu，否则菜单会先打开并把复制栏设为 aria-hidden。
  view.addEventListener("contextmenu", onContextMenu, true);
  // 按键先停止手势；实际输入由下列事件及渲染器 onData 清选区。
  // 不能在 Ctrl/Shift/Cmd 或复制按键上提前清空，否则键盘层会把 Ctrl+C 当成中断。
  container.addEventListener("keydown", cancel, true);
  const inputEvents = ["beforeinput", "input", "paste", "compositionstart"] as const;
  const cancelForInput = () => {
    options.selection?.clear();
    cancel();
  };
  for (const type of inputEvents) container.addEventListener(type, cancelForInput, true);
  view.addEventListener("blur", cancel);
  container.ownerDocument.addEventListener("visibilitychange", cancelForInput);

  return {
    cancel,
    setEnabled: (value) => {
      enabled = value;
      if (!value) cancelForInput();
    },
    dispose: () => {
      cancelForInput();
      enabled = false;
      container.removeEventListener("touchstart", onTouchStart, listenerOptions);
      container.removeEventListener("touchmove", onTouchMove, listenerOptions);
      container.removeEventListener("touchend", onTouchEnd, listenerOptions);
      container.removeEventListener("touchcancel", onTouchCancel, listenerOptions);
      view.removeEventListener("contextmenu", onContextMenu, true);
      container.removeEventListener("keydown", cancel, true);
      for (const type of inputEvents) container.removeEventListener(type, cancelForInput, true);
      view.removeEventListener("blur", cancel);
      container.ownerDocument.removeEventListener("visibilitychange", cancelForInput);
    },
  };
}
