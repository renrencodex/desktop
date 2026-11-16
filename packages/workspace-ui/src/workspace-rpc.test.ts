import { describe, expect, test } from "bun:test";
import { CMP_METHODS, FS_MAX_CHUNK_BYTES } from "@cloud-machine/client-contracts";

import {
  decodeWorkspaceText,
  readWorkspaceFile,
  type WorkspaceRpcClient,
  writeWorkspaceFile,
} from "./workspace-rpc";

function rpcWithReply(reply: unknown, calls: Array<{ method: string; params: unknown }>) {
  return {
    call<T>(method: string, params: unknown): Promise<T> {
      calls.push({ method, params });
      return Promise.resolve(reply as T);
    },
  } as unknown as WorkspaceRpcClient;
}

describe("Workspace file editing transport", () => {
  test("reads one complete atomic-edit-sized UTF-8 file", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const value = "你好";
    const data = Buffer.from(value).toString("base64");
    const rpc = rpcWithReply(
      { data, totalSize: new TextEncoder().encode(value).length, eof: true },
      calls,
    );

    expect(await readWorkspaceFile(rpc, "/workspace/file.txt")).toBe(value);
    expect(calls).toEqual([
      {
        method: CMP_METHODS.FS_READ,
        params: { path: "/workspace/file.txt", offset: 0, length: FS_MAX_CHUNK_BYTES },
      },
    ]);
  });

  test("rejects oversized files before requesting another chunk", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = rpcWithReply({ data: "", totalSize: FS_MAX_CHUNK_BYTES + 1, eof: false }, calls);

    await expect(readWorkspaceFile(rpc, "/workspace/large.txt")).rejects.toThrow("原子编辑上限");
    expect(calls).toHaveLength(1);
  });

  test("rejects binary and malformed UTF-8 content", () => {
    expect(() => decodeWorkspaceText(Uint8Array.of(0, 1, 2))).toThrow("二进制");
    expect(() => decodeWorkspaceText(Uint8Array.of(0xc3, 0x28))).toThrow("UTF-8");
  });

  test("saves with exactly one atomic fs.write call", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const value = "atomic";
    const rpc = rpcWithReply({ bytesWritten: value.length }, calls);

    await writeWorkspaceFile(rpc, "/workspace/file.txt", value);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: CMP_METHODS.FS_WRITE,
      params: { path: "/workspace/file.txt", truncate: true },
    });
    expect(calls[0]?.params).not.toHaveProperty("offset");
  });

  test("rejects oversized UTF-8 saves without writing a partial file", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = rpcWithReply({ bytesWritten: 0 }, calls);
    const oversized = `${"a".repeat(FS_MAX_CHUNK_BYTES)}界`;

    await expect(writeWorkspaceFile(rpc, "/workspace/file.txt", oversized)).rejects.toThrow(
      "原子保存上限",
    );
    expect(calls).toHaveLength(0);
  });
});
