import { getThemeDefinition, type ThemeColorScheme, type ThemeId } from "./themes";
import type { PreviewColorScheme } from "@cloud-machine/platform-api";

export function nativeWindowTheme(themeId: ThemeId): ThemeColorScheme {
  return getThemeDefinition(themeId).colorScheme;
}

/** Coalesce pending choices; never let an older async completion overwrite the latest choice. */
export function createNativeThemeSync(applyTheme: (theme: PreviewColorScheme) => Promise<void>) {
  let revision = 0;
  let applied: PreviewColorScheme | null = null;
  let pending = Promise.resolve();
  return (themeId: ThemeId): Promise<void> => {
    const theme = nativeWindowTheme(themeId);
    const current = ++revision;
    const task = pending.then(async () => {
      if (current !== revision || applied === theme) return;
      applied = null;
      await applyTheme(theme);
      applied = theme;
    });
    pending = task.catch(() => {});
    return task;
  };
}
