import type { KeyboardEvent } from "react";

/**
 * ARIA tabs 键盘导航：←/→ 循环移动，Home/End 到两端。
 * 返回目标 tab 的下标；不相关的按键返回 null。调用方负责聚焦与激活。
 */
export function tablistArrowTarget(event: KeyboardEvent<HTMLElement>): number | null {
  const { key, currentTarget } = event;
  if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") {
    return null;
  }
  // 重命名输入框内的方向键移动光标，不切换标签。
  if ((event.target as HTMLElement).tagName === "INPUT") return null;
  const tabs = Array.from(currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  if (tabs.length === 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return tabs.length - 1;
  const current = tabs.findIndex(
    (tab) => tab === document.activeElement || tab.contains(document.activeElement),
  );
  const from = current >= 0 ? current : 0;
  return key === "ArrowRight" ? (from + 1) % tabs.length : (from - 1 + tabs.length) % tabs.length;
}

export function focusTabAt(tablist: HTMLElement, index: number): void {
  tablist.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
}
