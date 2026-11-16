import { getThemeDefinition, type ThemeColorScheme, type ThemeId } from "./themes";
import type { PreviewColorScheme } from "@cloud-machine/platform-api";

export function nativeWindowTheme(themeId: ThemeId): ThemeColorScheme {
  return getThemeDefinition(themeId).colorScheme;
}

/** Coalesce pending choices; never let an older async completion overwrite the latest choice. */
export function createNativeThemeSync(
  setWindowTheme: (theme: PreviewColorScheme) => Promise<void>,
  setPreviewTheme: (theme: PreviewColorScheme) => Promise<void>,
) {
  let revision = 0;
  let applied: PreviewColorScheme | null = null;
  let pending = Promise.resolve();
  return (themeId: ThemeId, force = false): Promise<void> => {
    const theme = nativeWindowTheme(themeId);
    const current = ++revision;
    const task = pending.then(async () => {
      if (current !== revision || (!force && applied === theme)) return;
      // Invalidate before trying: partial failure can leave either target at a different theme.
      applied = null;
      const results = await Promise.allSettled([setWindowTheme(theme), setPreviewTheme(theme)]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      applied = theme;
    });
    pending = task.catch(() => {});
    return task;
  };
}
