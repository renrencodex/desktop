export interface TerminalScrollAnchor {
  /** 距 scrollback 底部的行数，0 表示跟随最新输出。 */
  viewportY: number;
  scrollbackLength: number;
}

/**
 * ghostty-web 0.4 的 write() 一律 scrollToBottom()，用户翻看历史时会被新输出拉回
 * 底部。写入新增的 scrollback 行数要叠加到 viewportY 上，视口才会停在原来那批内容
 * 上。scrollback 达到上限后被淘汰的行数无法得知，只能保持当前 viewportY。
 */
export function anchoredViewportY(before: TerminalScrollAnchor, scrollbackLength: number): number {
  const grown = Math.max(0, scrollbackLength - before.scrollbackLength);
  const target = Math.floor(before.viewportY) + grown;
  return Math.max(0, Math.min(scrollbackLength, target));
}
