import { describe, expect, test } from "bun:test";

import {
  canApplyFileRead,
  stableTerminalSession,
  workspaceDiffListNotices,
  workspaceDiffPatchNotices,
  workspaceMatchesRoute,
  workspaceParentPath,
} from "./workspace-workbench";

describe("Workspace file root", () => {
  test("parent navigation never escapes the registered Workspace directory", () => {
    expect(workspaceParentPath("/home/user/project/src", "/home/user/project")).toBe(
      "/home/user/project",
    );
    expect(workspaceParentPath("/home/user/project", "/home/user/project")).toBe(
      "/home/user/project",
    );
    expect(workspaceParentPath("/", "/home/user/project")).toBe("/home/user/project");
    expect(workspaceParentPath("/home/user/project-two/src", "/home/user/project")).toBe(
      "/home/user/project",
    );
  });
});

describe("Workspace workbench safety", () => {
  test("rejects a route whose machine does not own the Workspace", () => {
    expect(workspaceMatchesRoute("machine-a", undefined)).toBe(false);
    expect(workspaceMatchesRoute("machine-a", "machine-b")).toBe(false);
    expect(workspaceMatchesRoute("machine-a", "machine-a")).toBe(true);
  });

  test("stale or edit-raced file reads cannot replace editor content", () => {
    expect(canApplyFileRead(2, 3, 4, 4)).toBe(false);
    expect(canApplyFileRead(3, 3, 4, 5)).toBe(false);
    expect(canApplyFileRead(3, 3, 5, 5)).toBe(true);
  });

  test("terminal session identity is stable for a Workspace", () => {
    expect(stableTerminalSession("workspace_1")).toEqual({
      terminalTabId: "workspace_1",
      paneId: "main",
    });
    expect(stableTerminalSession("workspace_1")).toEqual(stableTerminalSession("workspace_1"));
  });

  test("diff truncation and non-text states are visible", () => {
    expect(workspaceDiffListNotices({ truncated: true, scanTruncated: true })).toHaveLength(2);
    expect(
      workspaceDiffPatchNotices({ binary: true, submodule: true, truncated: true }),
    ).toHaveLength(3);
  });
});
