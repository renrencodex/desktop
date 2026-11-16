import { create } from "zustand";

import {
  DEFAULT_THEME_ID,
  getThemeDefinition,
  isThemeId,
  type ThemeColorScheme,
  type ThemeId,
  THEME_STORAGE_KEY,
} from "../lib/themes";

interface ThemeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

interface ThemeRoot {
  dataset: { theme?: string };
  style: { colorScheme: string };
  classList: { toggle: (token: string, force?: boolean) => boolean };
}

function browserStorage(): ThemeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function browserRoot(): ThemeRoot | null {
  return typeof document === "undefined" ? null : document.documentElement;
}

export function readStoredThemeId(storage: ThemeStorage | null): ThemeId {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function persistThemeId(storage: ThemeStorage | null, themeId: ThemeId): boolean {
  try {
    storage?.setItem(THEME_STORAGE_KEY, themeId);
    return storage !== null;
  } catch {
    return false;
  }
}

export function applyThemeToRoot(root: ThemeRoot, themeId: ThemeId): ThemeColorScheme {
  const { colorScheme } = getThemeDefinition(themeId);
  root.dataset.theme = themeId;
  root.style.colorScheme = colorScheme;
  root.classList.toggle("dark", colorScheme === "dark");
  root.classList.toggle("light", colorScheme === "light");
  return colorScheme;
}

interface ThemeState {
  themeId: ThemeId;
  setTheme: (themeId: ThemeId) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  themeId: DEFAULT_THEME_ID,
  setTheme: (themeId) => {
    persistThemeId(browserStorage(), themeId);
    const root = browserRoot();
    if (root) applyThemeToRoot(root, themeId);
    set({ themeId });
  },
}));

export function initializeTheme(
  storage: ThemeStorage | null = browserStorage(),
  root: ThemeRoot | null = browserRoot(),
): ThemeId {
  const themeId = readStoredThemeId(storage);
  if (root) applyThemeToRoot(root, themeId);
  useThemeStore.setState({ themeId });
  return themeId;
}
