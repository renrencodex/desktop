import { expect, test } from "bun:test";
import type { WorkbenchLayout } from "@cloud-machine/api-client";

import { rebaseWorkbenchLayoutAfterTerminalClose } from "./workbench-layout-sync";

const remote: WorkbenchLayout = {
  version: 9,
  workspacePane: { tabs: [], activeTabId: null },
};
const staleLocal: WorkbenchLayout = {
  version: 9,
  workspacePane: {
    tabs: [
      {
        id: "terminal-1",
        type: "terminal",
        title: "终端",
        activePaneId: "pane-1",
        root: { type: "terminal-pane", paneId: "pane-1" },
      },
    ],
    activeTabId: "terminal-1",
  },
};

test("native close acknowledgement cannot resurrect a tab missing from the cached base", () => {
  expect(rebaseWorkbenchLayoutAfterTerminalClose(remote, staleLocal, remote, "terminal-1")).toEqual(
    remote,
  );
});
