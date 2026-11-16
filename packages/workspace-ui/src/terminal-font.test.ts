import { expect, test } from "bun:test";

import {
  TERMINAL_FONT_FALLBACK,
  TERMINAL_FONT_SIZE,
  onTerminalFontsLoaded,
  terminalFontFamily,
} from "./terminal-font";

function fixture(
  load?: (font: string, text: string) => Promise<FontFace[]>,
  family = '"Iosevka Term", "Noto Sans SC", monospace',
) {
  return {
    ownerDocument: {
      fonts: load ? { load } : undefined,
      defaultView: { getComputedStyle: () => ({ getPropertyValue: () => family }) },
    },
  } as unknown as HTMLElement;
}

test("terminal typography uses even 1:2-compatible sizes", () => {
  expect(TERMINAL_FONT_SIZE).toEqual({ phone: 10, default: 14 });
  expect(terminalFontFamily(fixture())).toBe('"Iosevka Term", "Noto Sans SC", monospace');
  expect(terminalFontFamily(fixture(undefined, ""))).toBe(TERMINAL_FONT_FALLBACK);
});

test("font notification waits for regular and bold and fires once", async () => {
  const requests: Array<{ font: string; text: string }> = [];
  const resolvers: Array<(faces: FontFace[]) => void> = [];
  const element = fixture(
    (font, text) =>
      new Promise<FontFace[]>((resolve) => {
        requests.push({ font, text });
        resolvers.push(resolve);
      }),
  );
  let calls = 0;
  onTerminalFontsLoaded(element, 14, () => {
    calls++;
  });

  expect(requests).toEqual([
    {
      font: '400 14px "Iosevka Term", "Noto Sans SC", monospace',
      text: "0O1IlMW中文←─★",
    },
    {
      font: '700 14px "Iosevka Term", "Noto Sans SC", monospace',
      text: "0O1IlMW中文←─★",
    },
  ]);
  resolvers[0]!([{} as FontFace]);
  await Promise.resolve();
  expect(calls).toBe(0);
  resolvers[1]!([{} as FontFace]);
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(1);
});

test("disposal, unavailable fonts, and loading failures keep the fallback", async () => {
  let calls = 0;
  const disposed = onTerminalFontsLoaded(
    fixture(async () => [{} as FontFace]),
    10,
    () => calls++,
  );
  disposed();
  onTerminalFontsLoaded(fixture(), 14, () => calls++);
  onTerminalFontsLoaded(
    fixture(async () => []),
    14,
    () => calls++,
  );
  onTerminalFontsLoaded(
    fixture(async () => {
      throw new Error("offline");
    }),
    14,
    () => calls++,
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(0);
});
