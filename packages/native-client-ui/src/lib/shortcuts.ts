/** 快捷键的单一事实来源：命令面板 shortcut 展示与 "?" 帮助面板共用。 */
export interface ShortcutEntry {
  keys: string;
  description: string;
  scope: string;
}

export const SHORTCUTS: readonly ShortcutEntry[] = [
  { keys: "Ctrl/⌘ K", description: "打开命令面板", scope: "全局" },
  { keys: "Ctrl/⌘ B", description: "切换资源侧栏", scope: "全局" },
  { keys: "?", description: "键盘快捷键帮助", scope: "全局" },
  { keys: "Ctrl/⌘ `", description: "切换到终端（无终端时新建）", scope: "工作台" },
  { keys: "Ctrl/⌘ W", description: "关闭当前工作台标签", scope: "工作台" },
  { keys: "Ctrl/⌘ S", description: "保存当前文件", scope: "编辑器" },
];

export const SHORTCUT_SIDEBAR = "Ctrl/⌘ B";
