export const MONO_FONT_FALLBACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Canvas/editor consumers need the resolved family, not a CSS var() expression. */
export function monoFontFamily(element: HTMLElement): string {
  return (
    element.ownerDocument.defaultView
      ?.getComputedStyle(element)
      .getPropertyValue("--font-mono")
      .trim() || MONO_FONT_FALLBACK
  );
}

/** Do not delay editor/PTY startup on a font request. A failed font keeps its fallback. */
export function onMonoFontLoaded(
  element: HTMLElement,
  size: number,
  onLoaded: () => void,
): () => void {
  let disposed = false;
  const fonts = element.ownerDocument.fonts;
  if (fonts?.load) {
    void fonts.load(`400 ${size}px ${monoFontFamily(element)}`, "0O1IlMW").then(
      (faces) => {
        if (!disposed && faces.length > 0) onLoaded();
      },
      () => {},
    );
  }
  return () => {
    disposed = true;
  };
}
