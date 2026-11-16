import { describe, expect, test } from "bun:test";
import {
  bindTerminalKeyboard,
  shouldCopyTerminalSelection,
  terminalKeyAction,
  terminalTouchKeyAction,
  terminalHistoryPageOffset,
  type TerminalKeyEvent,
  type TerminalKeyboardContext,
} from "./terminal-keyboard";

const context: TerminalKeyboardContext = {
  mac: false,
  hasSelection: false,
  applicationCursorKeys: false,
  alternateScreen: false,
};
const event = (key: string, extra: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent => ({
  type: "keydown",
  key,
  code: key,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...extra,
});
const send = (data: string) => ({ kind: "send" as const, data });

describe("shared terminal keyboard policy", () => {
  test("Page keys separate CLI input from history, including unknown remote state", () => {
    for (const [key, number, pages] of [
      ["PageUp", 5, 1],
      ["PageDown", 6, -1],
    ] as const) {
      expect(terminalKeyAction(event(key), context)).toEqual(send(`\x1b[${number}~`));
      for (const alternateScreen of [false, null])
        expect(
          terminalKeyAction(event(key, { shiftKey: true }), { ...context, alternateScreen }),
        ).toEqual({ kind: "history", pages });
      expect(
        terminalKeyAction(event(key, { shiftKey: true }), { ...context, alternateScreen: true }),
      ).toEqual(send(`\x1b[${number};2~`));
      expect(terminalKeyAction(event(key, { shiftKey: true, ctrlKey: true }), context)).toEqual(
        send(`\x1b[${number};6~`),
      );
    }
    expect(
      terminalHistoryPageOffset({ offsetLines: 0, historyLines: 100, viewportRows: 24 }, 1),
    ).toBe(23);
    expect(
      terminalHistoryPageOffset({ offsetLines: 95, historyLines: 100, viewportRows: 24 }, 1),
    ).toBe(100);
    expect(
      terminalHistoryPageOffset({ offsetLines: 5, historyLines: 100, viewportRows: 24 }, -1),
    ).toBe(0);
    expect(
      terminalHistoryPageOffset({ offsetLines: 0, historyLines: 100, viewportRows: 1 }, 1),
    ).toBe(1);
  });

  test("copy never sends an interrupt except unselected Ctrl+C", () => {
    expect(terminalKeyAction(event("c", { ctrlKey: true }), context)).toEqual(send("\x03"));
    expect(
      terminalKeyAction(event("c", { ctrlKey: true }), { ...context, hasSelection: true }),
    ).toEqual({ kind: "copy" });
    expect(terminalKeyAction(event("C", { ctrlKey: true, shiftKey: true }), context)).toEqual({
      kind: "copy",
    });
    expect(terminalKeyAction(event("c", { metaKey: true }), { ...context, mac: true })).toEqual({
      kind: "copy",
    });
    expect(terminalKeyAction(event("c", { metaKey: true }), context)).toEqual({ kind: "pass" });
  });

  test("native and explicit paste never run together", () => {
    for (const e of [
      event("v", { ctrlKey: true }),
      event("V", { ctrlKey: true, shiftKey: true }),
      event("Insert", { shiftKey: true }),
    ]) {
      expect(terminalKeyAction(e, context)).toEqual({ kind: "native-paste" });
      expect(terminalKeyAction(e, { ...context, mac: true })).toEqual({ kind: "paste" });
    }
    expect(terminalKeyAction(event("v", { metaKey: true }), { ...context, mac: true })).toEqual({
      kind: "native-paste",
    });
  });

  test("copy and paste follow the logical key instead of QWERTY physical positions", () => {
    for (const [key, code, keyCode] of [
      ["j", "KeyC", 67],
      ["k", "KeyV", 86],
    ] as const) {
      for (const modifiers of [
        { ctrlKey: true },
        { ctrlKey: true, shiftKey: true },
        { metaKey: true },
      ]) {
        const e = event(key, { code, keyCode, ...modifiers });
        for (const mac of [false, true])
          for (const hasSelection of [false, true])
            expect(terminalKeyAction(e, { ...context, mac, hasSelection })).toEqual({
              kind: "pass",
            });
        expect(shouldCopyTerminalSelection(e, true)).toBe(false);
      }
    }
    const copy = event("c", { code: "KeyI", ctrlKey: true });
    expect(terminalKeyAction(copy, context)).toEqual(send("\x03"));
    expect(terminalKeyAction(copy, { ...context, hasSelection: true })).toEqual({ kind: "copy" });
    expect(shouldCopyTerminalSelection(copy, true)).toBe(true);
    expect(terminalKeyAction(event("v", { code: "Period", ctrlKey: true }), context)).toEqual({
      kind: "native-paste",
    });
  });

  test("non-Latin clipboard shortcuts retain copy, interrupt and paste semantics", () => {
    for (const key of ["с", "С", "ψ", "ב"])
      for (const keyCode of [67, 0, undefined]) {
        const copy = event(key, { code: "KeyC", keyCode, ctrlKey: true });
        expect(terminalKeyAction(copy, { ...context, hasSelection: true })).toEqual({
          kind: "copy",
        });
        expect(shouldCopyTerminalSelection(copy, true)).toBe(true);
        expect(terminalKeyAction(copy, context)).toEqual(send("\x03"));
        expect(terminalKeyAction({ ...copy, shiftKey: true }, context)).toEqual({ kind: "copy" });
        expect(
          terminalKeyAction({ ...copy, ctrlKey: false, metaKey: true }, { ...context, mac: true }),
        ).toEqual({ kind: "copy" });
      }
    for (const key of ["м", "М"])
      for (const keyCode of [86, 0, undefined]) {
        const paste = event(key, { code: "KeyV", keyCode, ctrlKey: true });
        expect(terminalKeyAction(paste, context)).toEqual({ kind: "native-paste" });
        expect(terminalKeyAction({ ...paste, shiftKey: true }, context)).toEqual({
          kind: "native-paste",
        });
        expect(terminalKeyAction(paste, { ...context, mac: true })).toEqual({ kind: "paste" });
        expect(
          terminalKeyAction({ ...paste, ctrlKey: false, metaKey: true }, { ...context, mac: true }),
        ).toEqual({ kind: "native-paste" });
      }
  });

  test("non-Latin fallback respects a supplied virtual letter instead of overriding it", () => {
    for (const [key, code, keyCode] of [
      ["с", "KeyC", 74],
      ["м", "KeyV", 75],
      ["с", "KeyC", 49],
      ["м", "KeyV", 13],
    ] as const) {
      const e = event(key, { code, keyCode, ctrlKey: true });
      expect(terminalKeyAction(e, { ...context, hasSelection: true })).toEqual({ kind: "pass" });
      expect(shouldCopyTerminalSelection(e, true)).toBe(false);
    }
    expect(
      terminalKeyAction(event("с", { code: "", keyCode: 67, ctrlKey: true }), {
        ...context,
        hasSelection: true,
      }),
    ).toEqual({ kind: "copy" });
    expect(
      terminalKeyAction(event("м", { code: "", keyCode: 86, ctrlKey: true }), context),
    ).toEqual({ kind: "native-paste" });
  });

  test("clipboard fallback never claims Latin remaps, punctuation, unknown keys or IME", () => {
    for (const code of ["KeyC", "KeyV"])
      for (const key of [
        "j",
        "k",
        "é",
        "ç",
        "ß",
        ".",
        "1",
        " ",
        "",
        "Dead",
        "Process",
        "Unidentified",
        "😀",
      ])
        expect(
          terminalKeyAction(event(key, { code, ctrlKey: true }), {
            ...context,
            hasSelection: true,
          }),
        ).toEqual({ kind: "pass" });
    for (const extra of [
      { isComposing: true },
      { keyCode: 229 },
      { getModifierState: () => true },
      { altKey: true },
      { type: "keyup" },
      { ctrlKey: false },
    ]) {
      const e = event("с", { code: "KeyC", ctrlKey: true, ...extra });
      expect(terminalKeyAction(e, { ...context, hasSelection: true })).toEqual({ kind: "pass" });
      expect(shouldCopyTerminalSelection(e, true)).toBe(false);
    }
  });

  test("cursor keys, editing keys and F1–F12 retain all three modifiers", () => {
    for (let mask = 0; mask < 8; mask++) {
      const modifiers = {
        shiftKey: Boolean(mask & 1),
        altKey: Boolean(mask & 2),
        ctrlKey: Boolean(mask & 4),
      };
      for (const [key, final] of Object.entries({
        ArrowUp: "A",
        ArrowDown: "B",
        ArrowRight: "C",
        ArrowLeft: "D",
        Home: "H",
        End: "F",
      })) {
        for (const applicationCursorKeys of [false, true])
          expect(
            terminalKeyAction(event(key, modifiers), { ...context, applicationCursorKeys }),
          ).toEqual(
            send(
              mask
                ? `\x1b[1;${mask + 1}${final}`
                : `\x1b${applicationCursorKeys ? "O" : "["}${final}`,
            ),
          );
      }
      for (const [key, number] of Object.entries({
        Delete: 3,
        F5: 15,
        F6: 17,
        F7: 18,
        F8: 19,
        F9: 20,
        F10: 21,
        F11: 23,
        F12: 24,
      }))
        expect(terminalKeyAction(event(key, modifiers), context)).toEqual(
          send(`\x1b[${number}${mask ? `;${mask + 1}` : ""}~`),
        );
      for (let n = 1; n <= 4; n++)
        expect(terminalKeyAction(event(`F${n}`, modifiers), context)).toEqual(
          send(mask ? `\x1b[1;${mask + 1}${"PQRS"[n - 1]}` : `\x1bO${"PQRS"[n - 1]}`),
        );
    }
  });

  test("Alt letters retain case without stealing Option, AltGr or IME", () => {
    for (const key of ["b", "f", "d", "B", "F", "D", "!"])
      expect(terminalKeyAction(event(key, { altKey: true }), context)).toEqual(send(`\x1b${key}`));
    for (const e of [
      event("Dead", { altKey: true }),
      event("b", { isComposing: true }),
      event("Enter", { shiftKey: true, keyCode: 229 }),
      event("@", { altKey: true, ctrlKey: true }),
      event("b", { altKey: true, getModifierState: () => true }),
      event("Process"),
    ])
      expect(terminalKeyAction(e, context)).toEqual({ kind: "pass" });
    expect(terminalKeyAction(event("b", { altKey: true }), { ...context, mac: true })).toEqual({
      kind: "pass",
    });
    expect(terminalKeyAction(event("a"), context)).toEqual({ kind: "pass" });
    expect(terminalKeyAction(event("PageUp", { type: "keyup" }), context)).toEqual({
      kind: "pass",
    });
  });

  test("keypad uses key semantics, not its physical code", () => {
    for (const [code, key] of [
      ["Numpad0", "Insert"],
      ["Numpad1", "End"],
      ["Numpad2", "ArrowDown"],
      ["Numpad3", "PageDown"],
      ["Numpad4", "ArrowLeft"],
      ["Numpad6", "ArrowRight"],
      ["Numpad7", "Home"],
      ["Numpad8", "ArrowUp"],
      ["Numpad9", "PageUp"],
      ["NumpadDecimal", "Delete"],
    ])
      expect(terminalKeyAction(event(key!, { code }), context)).toEqual(
        terminalKeyAction(event(key!), context),
      );
    for (let n = 0; n <= 9; n++)
      expect(terminalKeyAction(event(String(n), { code: `Numpad${n}` }), context)).toEqual(
        send(String(n)),
      );
    expect(
      terminalKeyAction(event("Enter", { code: "NumpadEnter", shiftKey: true }), context),
    ).toEqual(send("\n"));
  });

  test("control aliases and touch inputs share the contract", () => {
    for (const [key, data] of [
      ["i", "\t"],
      ["m", "\r"],
      ["[", "\x1b"],
    ])
      expect(terminalKeyAction(event(key!, { ctrlKey: true }), context)).toEqual(send(data!));
    expect(terminalTouchKeyAction("pageUp", true, context)).toEqual({ kind: "history", pages: 1 });
    expect(terminalTouchKeyAction("pageDown", true, { ...context, alternateScreen: true })).toEqual(
      send("\x1b[6;2~"),
    );
    expect(terminalTouchKeyAction("/", true, context)).toEqual(send("?"));
    expect(terminalTouchKeyAction("enter", true, context)).toEqual(send("\n"));
    expect(
      terminalTouchKeyAction("home", false, { ...context, applicationCursorKeys: true }),
    ).toEqual(send("\x1bOH"));
  });
});

test("capture binding prevents duplicate encoding, keeps native paste and gates readonly input", () => {
  const host = new EventTarget() as unknown as HTMLElement;
  const actions: unknown[] = [];
  let readOnly = false;
  let lowerHandlers = 0;
  const binding = bindTerminalKeyboard(host, {
    context: () => context,
    isReadOnly: () => readOnly,
    send: (data) => actions.push(data),
    copy: () => actions.push("copy"),
    paste: () => actions.push("paste"),
    history: (pages) => actions.push(pages),
  });
  const lower = () => {
    lowerHandlers++;
  };
  host.addEventListener("keydown", lower);
  const press = (key: string, extra: Partial<TerminalKeyEvent> = {}) => {
    const e = new Event("keydown", { cancelable: true });
    Object.assign(
      e,
      Object.fromEntries(Object.entries(event(key, extra)).filter(([name]) => name !== "type")),
    );
    host.dispatchEvent(e);
    return e.defaultPrevented;
  };
  expect(press("PageUp")).toBe(true);
  expect(actions).toEqual(["\x1b[5~"]);
  expect(press("v", { ctrlKey: true })).toBe(false);
  expect(actions).toHaveLength(1);
  expect(lowerHandlers).toBe(0);
  readOnly = true;
  expect(press("v", { ctrlKey: true })).toBe(true);
  press("PageUp");
  press("C", { ctrlKey: true, shiftKey: true });
  binding.sendKey("pageUp", true);
  expect(actions).toEqual(["\x1b[5~", "copy", 1]);
  host.dispatchEvent(new Event("compositionstart"));
  expect(press("Enter", { shiftKey: true })).toBe(false);
  host.dispatchEvent(new Event("compositionend"));
  expect(lowerHandlers).toBe(1);
  binding.dispose();
  expect(press("PageUp")).toBe(false);
  expect(lowerHandlers).toBe(2);
});

test("capture binding forwards every consecutive keyboard and touch interrupt", () => {
  const host = new EventTarget() as unknown as HTMLElement;
  const actions: unknown[] = [];
  const binding = bindTerminalKeyboard(host, {
    context: () => context,
    isReadOnly: () => false,
    send: (data) => actions.push(data),
    copy: () => actions.push("copy"),
    paste: () => actions.push("paste"),
    history: (pages) => actions.push(pages),
  });
  const press = (key: string, extra: Partial<TerminalKeyEvent> & { repeat?: boolean } = {}) => {
    const e = new Event("keydown", { cancelable: true });
    Object.assign(
      e,
      Object.fromEntries(Object.entries(event(key, extra)).filter(([name]) => name !== "type")),
    );
    host.dispatchEvent(e);
  };

  press("c", { code: "KeyC", ctrlKey: true });
  press("c", { code: "KeyC", ctrlKey: true });
  press("c", { code: "KeyC", ctrlKey: true, repeat: true });
  binding.sendKey("interrupt", false);
  binding.sendKey("interrupt", false);
  expect(actions).toEqual(["\x03", "\x03", "\x03", "\x03", "\x03"]);

  binding.dispose();
});
