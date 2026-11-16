import type { TerminalLayoutNode } from "@cloud-machine/api-client";

export const MIN_TERMINAL_PANE_WIDTH = 160;
export const MIN_TERMINAL_PANE_HEIGHT = 96;
export const TERMINAL_SPLIT_GAP = 1;

export interface TerminalPaneSize {
  width: number;
  height: number;
}

/** Minimum canvas size that preserves every leaf, independent of saved ratios. */
export function terminalTreeMinimumSize(node: TerminalLayoutNode): TerminalPaneSize {
  if (node.type === "terminal-pane")
    return { width: MIN_TERMINAL_PANE_WIDTH, height: MIN_TERMINAL_PANE_HEIGHT };
  const first = terminalTreeMinimumSize(node.first);
  const second = terminalTreeMinimumSize(node.second);
  return node.orientation === "row"
    ? {
        width: first.width + second.width + TERMINAL_SPLIT_GAP,
        height: Math.max(first.height, second.height),
      }
    : {
        width: Math.max(first.width, second.width),
        height: first.height + second.height + TERMINAL_SPLIT_GAP,
      };
}

export function canSplitTerminalSize(
  size: TerminalPaneSize,
  orientation: "row" | "column",
): boolean {
  return orientation === "row"
    ? size.width >= 2 * MIN_TERMINAL_PANE_WIDTH + TERMINAL_SPLIT_GAP &&
        size.height >= MIN_TERMINAL_PANE_HEIGHT
    : size.height >= 2 * MIN_TERMINAL_PANE_HEIGHT + TERMINAL_SPLIT_GAP &&
        size.width >= MIN_TERMINAL_PANE_WIDTH;
}

/** CSS constrains both subtrees on resize without rewriting the persisted ratio. */
export function terminalSplitBasis(
  ratio: number,
  firstMinimum: number,
  secondMinimum: number,
): string {
  const percent = Math.min(85, Math.max(15, ratio));
  return `clamp(${firstMinimum}px, calc(${percent}% - ${(TERMINAL_SPLIT_GAP * percent) / 100}px), calc(100% - ${TERMINAL_SPLIT_GAP + secondMinimum}px))`;
}
