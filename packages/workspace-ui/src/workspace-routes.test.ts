import { describe, expect, test } from "bun:test";

import {
  buildMachineRoute,
  buildWorkspaceRoute,
  isWorkspaceRoute,
  parseWorkspaceRoute,
  workspaceRecoveryTarget,
} from "./workspace-routes";

describe("workspace routes", () => {
  test("构建并解析规范 Workspace 路由", () => {
    expect(buildMachineRoute("m-1")).toBe("/machines/m-1");
    expect(buildWorkspaceRoute("m-1", "w-1")).toBe("/machines/m-1/workspaces/w-1");
    expect(parseWorkspaceRoute("/machines/m-1/workspaces/w-1")).toEqual({
      machineId: "m-1",
      workspaceId: "w-1",
    });
    expect(parseWorkspaceRoute("/machines/m-1/workspaces/w-1/")).toEqual({
      machineId: "m-1",
      workspaceId: "w-1",
    });
  });

  test("规范解析拒绝非主壳入口，范围判断接受子路由", () => {
    expect(parseWorkspaceRoute("/machines/m-1/workspaces/w-1/files")).toBeNull();
    expect(parseWorkspaceRoute("/machines/m-1")).toBeNull();
    expect(isWorkspaceRoute("/machines/m-1/workspaces/w-1/files", "m-1", "w-1")).toBe(true);
    expect(isWorkspaceRoute("/machines/m-1/workspaces/w-10", "m-1", "w-1")).toBe(false);
  });
});

describe("workspace recovery", () => {
  const base = {
    machineId: "m-1",
    workspaceId: "w-1",
    machineNotFound: false,
    machineFound: true,
    workspaceNotFound: false,
  };

  test("按资源状态返回稳定的恢复地址", () => {
    expect(workspaceRecoveryTarget({ ...base, machineNotFound: true })).toBe("/");
    expect(workspaceRecoveryTarget({ ...base, machineFound: false, workspaceNotFound: true })).toBe(
      null,
    );
    expect(workspaceRecoveryTarget({ ...base, workspaceNotFound: true })).toBe("/machines/m-1");
    expect(workspaceRecoveryTarget({ ...base, workspaceMachineId: "m-2" })).toBe(
      "/machines/m-2/workspaces/w-1",
    );
    expect(workspaceRecoveryTarget({ ...base, workspaceMachineId: "m-1" })).toBeNull();
  });
});
