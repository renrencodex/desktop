import { expect, test } from "bun:test";

import {
  connectedWorkspaceKeys,
  protectedWorkspace,
  trimWorkspaces,
  workspaceLocation,
} from "./workspace-shell";

test("主壳只保留规范路由并清理一次性 session 参数", () => {
  expect(workspaceLocation("/machines/m/workspaces/w", "session=s&panel=files")).toEqual({
    key: "m:w",
    machineId: "m",
    workspaceId: "w",
    pathname: "/machines/m/workspaces/w",
    search: "panel=files",
  });
  expect(workspaceLocation("/machines/m/workspaces/w/files")).toBeNull();
});

test("连接预算固定保留最近五个并优先活动 Workspace", () => {
  const entries = Array.from({ length: 7 }, (_, index) => ({ key: String(index) }));
  expect([...connectedWorkspaceKeys(entries, "0")]).toEqual(["3", "4", "5", "6", "0"]);
  expect([...connectedWorkspaceKeys(entries, undefined)]).toEqual(["2", "3", "4", "5", "6"]);
});

test("主壳仅淘汰已注册、空闲且非活动的 Workspace", () => {
  const entries = Array.from({ length: 7 }, (_, index) => ({ key: String(index) }));
  const idle = Object.fromEntries(entries.map(({ key }) => [key, { dirty: 0, busy: false }]));
  expect(trimWorkspaces(entries, "0", idle).map(({ key }) => key)).toEqual([
    "0",
    "3",
    "4",
    "5",
    "6",
  ]);
  expect(protectedWorkspace({ dirty: 1, busy: false })).toBe(true);
  expect(protectedWorkspace({ dirty: 0, busy: true })).toBe(true);
  expect(protectedWorkspace({ dirty: 0, busy: false, unsynced: true })).toBe(true);
  expect(trimWorkspaces(entries, "6", {})).toEqual(entries);
});
