export const TERMINAL_FONT_SIZE = {
  phone: 10,
  default: 14,
} as const;

export const TERMINAL_FONT_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const TERMINAL_FONT_LOAD_SAMPLE = "0O1IlMW中文←─★";

/** Canvas renderers need the resolved family instead of a CSS var() expression. */
export function terminalFontFamily(element: HTMLElement): string {
  return (
    element.ownerDocument.defaultView
      ?.getComputedStyle(element)
      .getPropertyValue("--font-terminal")
      .trim() || TERMINAL_FONT_FALLBACK
  );
}

/** Keep PTY startup immediate, then notify once both terminal font weights are ready. */
export function onTerminalFontsLoaded(
  element: HTMLElement,
  size: number,
  onLoaded: () => void,
): () => void {
  let disposed = false;
  const fonts = element.ownerDocument.fonts;
  if (fonts?.load) {
    const family = terminalFontFamily(element);
    void Promise.all([
      fonts.load(`400 ${size}px ${family}`, TERMINAL_FONT_LOAD_SAMPLE),
      fonts.load(`700 ${size}px ${family}`, TERMINAL_FONT_LOAD_SAMPLE),
    ]).then(
      (faces) => {
        if (!disposed && faces.every((weight) => weight.length > 0)) onLoaded();
      },
      () => {},
    );
  }
  return () => {
    disposed = true;
  };
}
