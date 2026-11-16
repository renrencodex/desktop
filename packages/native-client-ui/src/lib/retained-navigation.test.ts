import { describe, expect, mock, test } from "bun:test";
import type { HostNavigation } from "@cloud-machine/workspace-ui";

import { navigateRetainedWorkspace } from "./retained-navigation";

function navigationDouble() {
  return {
    push: mock(() => undefined),
    replace: mock(() => undefined),
    prefetch: mock(() => undefined),
  } satisfies HostNavigation;
}

describe("retained Desktop workspace navigation", () => {
  test("commits push and replace through the host navigation adapter", () => {
    const navigation = navigationDouble();

    navigateRetainedWorkspace(navigation, "/machines/m1/workspaces/w1", false);
    navigateRetainedWorkspace(navigation, "/machines/m1/workspaces/w2", true);

    expect(navigation.push).toHaveBeenCalledWith("/machines/m1/workspaces/w1");
    expect(navigation.replace).toHaveBeenCalledWith("/machines/m1/workspaces/w2");
  });
});
