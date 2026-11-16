const ESC = 0x1b;
const BEL = 0x07;
const ST = 0x5c;
const OSC52_PREFIX = Uint8Array.of(ESC, 0x5d, 0x35, 0x32, 0x3b);

/** OSC 52 clipboard writes are intentionally smaller than terminal output frames. */
export const TERMINAL_OSC52_MAX_TEXT_BYTES = 64 * 1024;
const MAX_BASE64_BYTES = Math.ceil(TERMINAL_OSC52_MAX_TEXT_BYTES / 3) * 4;
const MAX_OSC52_BODY_BYTES = MAX_BASE64_BYTES + 2; // `c;` plus the encoded payload.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type TerminalOsc52Write = (text: string) => void | Promise<void>;

export interface TerminalOsc52Filter {
  push(data: string | Uint8Array): Uint8Array;
  reset(): void;
}

function decodeClipboardWrite(body: readonly number[]): string | null {
  if (body.length < 3 || body[0] !== 0x63 || body[1] !== 0x3b) return null;
  const payload = new TextDecoder().decode(Uint8Array.from(body.slice(2)));
  if (!payload || payload.length > MAX_BASE64_BYTES || payload.length % 4 || !BASE64.test(payload))
    return null;
  try {
    const binary = atob(payload);
    if (binary.length > TERMINAL_OSC52_MAX_TEXT_BYTES) return null;
    const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Removes OSC 52 from a terminal byte stream and forwards accepted clipboard writes.
 *
 * Only the `c` selection and base64-encoded UTF-8 writes are accepted. Clipboard reads
 * (`?`), malformed input, and oversized sequences are consumed without reaching the
 * terminal renderer. State is retained across WebSocket output frames.
 */
export function createTerminalOsc52Filter(onWrite?: TerminalOsc52Write): TerminalOsc52Filter {
  let state: "text" | "prefix" | "osc52" | "discard" = "text";
  let prefix: number[] = [];
  let body: number[] = [];
  let escaped = false;

  const finishOsc52 = () => {
    const text = decodeClipboardWrite(body);
    if (text !== null && onWrite) {
      try {
        const result = onWrite(text);
        if (result && typeof result.then === "function") void result.catch(() => {});
      } catch {
        // Clipboard failures are owned by the host callback and must not break rendering.
      }
    }
    state = "text";
    body = [];
    escaped = false;
  };

  const discardOsc52 = () => {
    state = "text";
    body = [];
    escaped = false;
  };

  return {
    push(data) {
      const input = typeof data === "string" ? new TextEncoder().encode(data) : data;
      if (state === "text" && !input.includes(ESC)) return input;
      // At most a partial prefix retained from the previous frame can make the
      // output longer than this frame. Avoid boxing every terminal byte in number[].
      const output = new Uint8Array(input.length + OSC52_PREFIX.length);
      let outputLength = 0;
      const emit = (byte: number) => {
        output[outputLength++] = byte;
      };
      for (const byte of input) {
        if (state === "text") {
          if (byte === ESC) {
            state = "prefix";
            prefix = [byte];
          } else {
            emit(byte);
          }
          continue;
        }

        if (state === "prefix") {
          prefix.push(byte);
          const index = prefix.length - 1;
          if (byte === OSC52_PREFIX[index]) {
            if (prefix.length === OSC52_PREFIX.length) {
              state = "osc52";
              prefix = [];
              body = [];
              escaped = false;
            }
            continue;
          }
          if (byte === ESC) {
            for (const value of prefix.slice(0, -1)) emit(value);
            prefix = [ESC];
          } else {
            for (const value of prefix) emit(value);
            prefix = [];
            state = "text";
          }
          continue;
        }

        if (state === "discard") {
          if (byte === BEL || (escaped && byte === ST)) {
            discardOsc52();
          } else {
            escaped = byte === ESC;
          }
          continue;
        }

        if (byte === BEL || (escaped && byte === ST)) {
          finishOsc52();
          continue;
        }
        if (escaped) {
          body.push(ESC);
          escaped = false;
        }
        if (byte === ESC) {
          escaped = true;
        } else {
          body.push(byte);
        }
        if (body.length > MAX_OSC52_BODY_BYTES) {
          body = [];
          state = "discard";
          escaped = false;
        }
      }
      return output.subarray(0, outputLength);
    },
    reset() {
      state = "text";
      prefix = [];
      body = [];
      escaped = false;
    },
  };
}
