export type ThemeColorScheme = "light" | "dark";

interface EditorPalette {
  colorScheme: ThemeColorScheme;
  background: string;
  foreground: string;
  lineHighlight: string;
  lineNumber: string;
  activeLineNumber: string;
  cursor: string;
  selection: string;
  widgetBackground: string;
  widgetBorder: string;
  gutterBackground: string;
  syntax?: {
    comment: string;
    keyword: string;
    string: string;
    number: string;
    function: string;
    type: string;
    variable: string;
    operator: string;
  };
}

interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

interface ThemeDefinitionShape {
  id: string;
  name: string;
  description: string;
  colorScheme: ThemeColorScheme;
  surface: string;
  accent: string;
  editor: EditorPalette;
  terminal: TerminalPalette;
}

export const THEME_STORAGE_KEY = "cloud-machine.theme";

/**
 * 主题唯一目录。主题菜单、命令面板和首屏初始化脚本都从这里派生；
 * 后续扩展主题时只需补充定义和对应 CSS 变量，Monaco 与终端无需再加分支。
 */
export const THEME_DEFINITIONS = [
  {
    id: "ink-white",
    name: "墨白",
    description: "亮色 · 黑白",
    colorScheme: "light",
    surface: "#ffffff",
    accent: "#171717",
    editor: {
      colorScheme: "dark",
      background: "#2b2b2b",
      foreground: "#e4e4e7",
      lineHighlight: "#222225",
      lineNumber: "#85858f",
      activeLineNumber: "#e4e4e7",
      cursor: "#f4f4f5",
      selection: "#3f3f46",
      widgetBackground: "#222225",
      widgetBorder: "#3f3f46",
      gutterBackground: "#2b2b2b",
      syntax: {
        comment: "#92929d",
        keyword: "#c4a7e7",
        string: "#a3c98b",
        number: "#e5c07b",
        function: "#82aaff",
        type: "#89d1dc",
        variable: "#e4e4e7",
        operator: "#b4b4bd",
      },
    },
    terminal: {
      background: "#2b2b2b",
      foreground: "#cdd9e5",
      cursor: "#bbbbbb",
      cursorAccent: "#2b2b2b",
      selectionBackground: "#214283",
      selectionForeground: "#fafafa",
      black: "#27272a",
      red: "#f4878e",
      green: "#a3c98b",
      yellow: "#e5c07b",
      blue: "#82aaff",
      magenta: "#c4a7e7",
      cyan: "#89d1dc",
      white: "#d4d4d8",
      brightBlack: "#999999",
      brightRed: "#ffabb0",
      brightGreen: "#b9dfa2",
      brightYellow: "#f2d99a",
      brightBlue: "#a6c4ff",
      brightMagenta: "#dcc4f5",
      brightCyan: "#b0e5ed",
      brightWhite: "#fafafa",
    },
  },
  {
    id: "night-moss",
    name: "绿苔",
    description: "深色 · 苔绿",
    colorScheme: "dark",
    surface: "#151a12",
    accent: "#76b900",
    editor: {
      colorScheme: "dark",
      background: "#111610",
      foreground: "#dce5d4",
      lineHighlight: "#1b2419",
      lineNumber: "#87977e",
      activeLineNumber: "#dce5d4",
      cursor: "#a6d66d",
      selection: "#35482d",
      widgetBackground: "#1b2419",
      widgetBorder: "#35482d",
      gutterBackground: "#111610",
      syntax: {
        comment: "#87977e",
        keyword: "#c1a0cb",
        string: "#a6c982",
        number: "#dac486",
        function: "#91b5cf",
        type: "#8fc9bd",
        variable: "#dce5d4",
        operator: "#b0bea5",
      },
    },
    terminal: {
      background: "#111610",
      foreground: "#8fd812",
      cursor: "#a6d66d",
      cursorAccent: "#111610",
      selectionBackground: "#35482d",
      selectionForeground: "#f0f5e9",
      black: "#222c1e",
      red: "#e89386",
      green: "#a6c982",
      yellow: "#dac486",
      blue: "#91b5cf",
      magenta: "#c1a0cb",
      cyan: "#8fc9bd",
      white: "#d3ddc9",
      brightBlack: "#87977e",
      brightRed: "#f4b0a4",
      brightGreen: "#bfdfa0",
      brightYellow: "#eddaa3",
      brightBlue: "#b0cfe5",
      brightMagenta: "#d9bddf",
      brightCyan: "#ace0d4",
      brightWhite: "#f0f5e9",
    },
  },
  {
    id: "cursor-dark",
    name: "Cursor",
    description: "深色 · 黑灰",
    colorScheme: "dark",
    surface: "#181818",
    accent: "#3a3a3a",
    editor: {
      colorScheme: "dark",
      background: "#181818",
      foreground: "#f0f0f0",
      lineHighlight: "#262626",
      lineNumber: "#989898",
      activeLineNumber: "#f0f0f0",
      cursor: "#f0f0f0",
      selection: "#404040",
      widgetBackground: "#141414",
      widgetBorder: "#353535",
      gutterBackground: "#181818",
      syntax: {
        comment: "#989898",
        keyword: "#82d2ce",
        string: "#e394dc",
        number: "#ebc88d",
        function: "#efb080",
        type: "#87c3ff",
        variable: "#d6d6dd",
        operator: "#82d2ce",
      },
    },
    terminal: {
      background: "#141414",
      foreground: "#f0f0f0",
      cursor: "#f0f0f0",
      cursorAccent: "#141414",
      selectionBackground: "#2e2e2e",
      selectionForeground: "#f0f0f0",
      black: "#242424",
      red: "#fc6b83",
      green: "#3fa266",
      yellow: "#d2943e",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#f0f0f0",
      brightBlack: "#989898",
      brightRed: "#fc6b83",
      brightGreen: "#70b489",
      brightYellow: "#f1b467",
      brightBlue: "#87a6c4",
      brightMagenta: "#b48ead",
      brightCyan: "#88c0d0",
      brightWhite: "#ffffff",
    },
  },
] as const satisfies readonly ThemeDefinitionShape[];

export type ThemeDefinition = (typeof THEME_DEFINITIONS)[number];
export type ThemeId = ThemeDefinition["id"];

export const DEFAULT_THEME_ID: ThemeId = "ink-white";

/** 编辑器配色独立于工作台明暗模式，各主题使用对应的自定义 Monaco 色板。 */
export function monacoThemeName(themeId: ThemeId): string {
  return `cm-${themeId}`;
}

export function isThemeId(value: unknown): value is ThemeId {
  return THEME_DEFINITIONS.some((theme) => theme.id === value);
}

export function getThemeDefinition(themeId: ThemeId): ThemeDefinition {
  return THEME_DEFINITIONS.find((theme) => theme.id === themeId) ?? THEME_DEFINITIONS[0];
}
