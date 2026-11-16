export const VIEWPORT_SYNC_EVENT = "cm-viewport-sync";

// A bounded sampling window, not a height/keyboard-size compensation. Some
// mobile browsers expose the final geometry after their last resize event.
const SETTLE_MS = 1_200;
const PROPERTIES = [
  "--cm-viewport-height",
  "--cm-viewport-width",
  "--cm-viewport-offset-top",
  "--cm-viewport-offset-left",
  "--cm-viewport-bottom",
] as const;

export function bindVisualViewport(window: Window): () => void {
  const document = window.document;
  const root = document.documentElement;
  const viewport = window.visualViewport;
  let frame = 0;
  let timer = 0;
  let deadline = 0;
  let previousSnapshot = "";
  let disposed = false;

  const sync = () => {
    const height = viewport?.height ?? window.innerHeight;
    const width = viewport?.width ?? window.innerWidth;
    const top = viewport?.offsetTop ?? 0;
    const left = viewport?.offsetLeft ?? 0;
    const bottom = Math.max(0, window.innerHeight - height - top);
    const values = [height, width, top, left, bottom];
    if (height <= 0 || width <= 0 || values.some((value) => !Number.isFinite(value))) return;
    const rounded = values.map(Math.round);
    const snapshot = [...rounded, window.innerHeight, viewport?.scale ?? 1].join(",");
    if (snapshot === previousSnapshot) return;
    previousSnapshot = snapshot;
    PROPERTIES.forEach((name, index) => {
      const value = `${rounded[index]}px`;
      if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
    });
    // Keyboard visibility subscribers must also see geometry discovered by
    // polling, rather than waiting for another browser resize event.
    const event = document.createEvent("Event");
    event.initEvent(VIEWPORT_SYNC_EVENT, false, false);
    window.dispatchEvent(event);
  };

  const stop = () => {
    window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    frame = timer = 0;
  };
  const sample = () => {
    frame = 0;
    if (disposed || document.hidden) return;
    sync();
    if (window.performance.now() < deadline) frame = window.requestAnimationFrame(sample);
  };
  const settle = () => {
    if (disposed) return;
    if (document.hidden) {
      stop();
      return;
    }
    sync();
    deadline = window.performance.now() + SETTLE_MS;
    if (!frame) frame = window.requestAnimationFrame(sample);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      stop();
      if (!disposed && !document.hidden) sync();
    }, SETTLE_MS);
  };

  const sources: Array<[EventTarget, string[]]> = [
    [window, ["resize", "scroll", "orientationchange", "pageshow", "focus"]],
    [document, ["focusin", "focusout", "visibilitychange"]],
  ];
  if (viewport) sources.push([viewport, ["resize", "scroll", "scrollend"]]);
  for (const [target, events] of sources)
    for (const event of events) target.addEventListener(event, settle);
  settle();

  return () => {
    disposed = true;
    stop();
    for (const [target, events] of sources)
      for (const event of events) target.removeEventListener(event, settle);
    for (const property of PROPERTIES) root.style.removeProperty(property);
  };
}
