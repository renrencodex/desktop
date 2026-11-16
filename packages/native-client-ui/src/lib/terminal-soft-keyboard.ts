/**
 * 移动浏览器把软键盘绑在"可编辑元素持有焦点"上：ghostty 的 open() 会把终端容器设成
 * contenteditable，并在 canvas 的 touchend 里聚焦隐藏输入框，于是任何触摸——包括滑动
 * 翻看历史——都会拉起输入法。终端的 DOM 焦点同时决定光标是否可见，不能简单失焦，
 * 所以触屏设备默认关闭容器的 contenteditable，
 * 隐藏输入框用 inputmode=none 抑制软键盘，保留外接键盘的中文组合输入能力。
 * readOnly 由渲染器的连接状态管理，软键盘开关不能覆盖它。
 */
export interface TerminalSoftKeyboard {
  /** 是否允许软键盘弹出；触屏设备默认不允许。 */
  setAllowed(value: boolean): void;
  isAllowed(): boolean;
  dispose(): void;
}

export const SOFT_KEYBOARD_GATE_QUERY = "(pointer: coarse)";

function shouldGate(container: HTMLElement): boolean {
  const view = container.ownerDocument.defaultView;
  if (typeof view?.matchMedia !== "function") return false;
  return view.matchMedia(SOFT_KEYBOARD_GATE_QUERY).matches === true;
}

export function bindTerminalSoftKeyboard(
  container: HTMLElement,
  getInput: () => HTMLTextAreaElement | undefined,
): TerminalSoftKeyboard {
  const gated = shouldGate(container);
  // ghostty 的宿主是 contenteditable，xterm 回退的容器不是；恢复时按各自的原样写回。
  const editableHost = container.getAttribute("contenteditable");
  let allowed = !gated;

  const apply = () => {
    const input = getInput();
    if (allowed) {
      if (editableHost === null) container.removeAttribute("contenteditable");
      else container.setAttribute("contenteditable", editableHost);
      container.removeAttribute("inputmode");
      input?.removeAttribute("inputmode");
      return;
    }
    // 宿主不直接编辑，输入仍交给隐藏输入框；不能用 readOnly 抑制软键盘，
    // 否则外接键盘虽然仍能发送 keydown，却无法完成 IME 组合输入。
    container.setAttribute("contenteditable", "false");
    container.setAttribute("inputmode", "none");
    input?.setAttribute("inputmode", "none");
  };

  if (gated) apply();

  return {
    setAllowed: (value) => {
      if (!gated) return;
      allowed = value;
      apply();
    },
    isAllowed: () => allowed,
    dispose: () => {
      if (!gated || allowed) return;
      allowed = true;
      apply();
    },
  };
}
