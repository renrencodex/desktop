import { describe, expect, test } from "bun:test";

import { createTerminalOsc52Filter, TERMINAL_OSC52_MAX_TEXT_BYTES } from "./terminal-osc52";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function osc52(text: string, terminator = "\u0007"): Uint8Array {
  const payload = btoa(String.fromCharCode(...encoder.encode(text)));
  return encoder.encode(`\u001b]52;c;${payload}${terminator}`);
}

describe("createTerminalOsc52Filter", () => {
  test("保留普通输出并提取 BEL 结束的剪贴板写入", () => {
    const writes: string[] = [];
    const filter = createTerminalOsc52Filter((text) => {
      writes.push(text);
    });
    const input = new Uint8Array([
      ...encoder.encode("before"),
      ...osc52("https://example.com/login"),
      ...encoder.encode("after"),
    ]);

    expect(decoder.decode(filter.push(input))).toBe("beforeafter");
    expect(writes).toEqual(["https://example.com/login"]);
  });

  test("跨任意输出分帧识别 ST 结束的 UTF-8 写入", () => {
    const writes: string[] = [];
    const filter = createTerminalOsc52Filter((text) => {
      writes.push(text);
    });
    const input = new Uint8Array([
      ...encoder.encode("left"),
      ...osc52("登录地址： https://mimo.example", "\u001b\\"),
      ...encoder.encode("right"),
    ]);
    const output: number[] = [];
    for (const byte of input) output.push(...filter.push(Uint8Array.of(byte)));

    expect(decoder.decode(Uint8Array.from(output))).toBe("leftright");
    expect(writes).toEqual(["登录地址： https://mimo.example"]);
  });

  test("兼容 tmux DCS 包装中的 OSC 52", () => {
    const writes: string[] = [];
    const filter = createTerminalOsc52Filter((text) => {
      writes.push(text);
    });
    const wrapped = new Uint8Array([
      ...encoder.encode("\u001bPtmux;\u001b"),
      ...osc52("https://mimo.example/device"),
      ...encoder.encode("\u001b\\"),
    ]);

    expect(decoder.decode(filter.push(wrapped))).toBe("\u001bPtmux;\u001b\u001b\\");
    expect(writes).toEqual(["https://mimo.example/device"]);
  });

  test("不执行读取查询、非 c selection、非法 base64 或非法 UTF-8", () => {
    const writes: string[] = [];
    const filter = createTerminalOsc52Filter((text) => {
      writes.push(text);
    });
    const input = encoder.encode(
      "a\u001b]52;c;?\u0007b\u001b]52;p;dGVzdA==\u0007c\u001b]52;c;%%%\u0007d\u001b]52;c;/w==\u0007e",
    );

    expect(decoder.decode(filter.push(input))).toBe("abcde");
    expect(writes).toEqual([]);
  });

  test("丢弃超长序列且能继续处理后续输出", () => {
    const writes: string[] = [];
    const filter = createTerminalOsc52Filter((text) => {
      writes.push(text);
    });
    const oversized = `\u001b]52;c;${"A".repeat(
      Math.ceil(TERMINAL_OSC52_MAX_TEXT_BYTES / 3) * 4 + 4,
    )}\u0007visible`;

    expect(decoder.decode(filter.push(encoder.encode(oversized)))).toBe("visible");
    expect(writes).toEqual([]);
  });

  test("reset 丢弃未完成序列", () => {
    const writes: string[] = [];
    const filter = createTerminalOsc52Filter((text) => {
      writes.push(text);
    });
    expect(filter.push(encoder.encode("hidden\u001b]52;c;dGV"))).toEqual(encoder.encode("hidden"));
    filter.reset();

    expect(decoder.decode(filter.push(encoder.encode("visible")))).toBe("visible");
    expect(writes).toEqual([]);
  });
});
