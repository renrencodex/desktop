import { afterEach, expect, test } from "bun:test";

import {
  beginWorkspaceNavigation,
  clearWorkspaceNavigationPerformance,
  CLIENT_PERFORMANCE_MEASURES,
  recordWorkspaceNavigation,
} from "./client-performance";

afterEach(() => {
  clearWorkspaceNavigationPerformance();
  performance.clearMeasures();
});

test("workspace timing is identifier-free and records each stage once per navigation", () => {
  beginWorkspaceNavigation("machine-secret:workspace-secret", {
    client: "web",
    temperature: "cold",
  });

  expect(
    recordWorkspaceNavigation(
      "machine-secret:workspace-secret",
      CLIENT_PERFORMANCE_MEASURES.workspaceInteractive,
    ),
  ).toBeNumber();
  expect(
    recordWorkspaceNavigation(
      "machine-secret:workspace-secret",
      CLIENT_PERFORMANCE_MEASURES.workspaceInteractive,
    ),
  ).toBeNull();

  const [entry] = performance.getEntriesByName(
    CLIENT_PERFORMANCE_MEASURES.workspaceInteractive,
    "measure",
  ) as PerformanceMeasure[];
  expect(entry).toBeDefined();
  expect(entry!.detail).toEqual({ client: "web", temperature: "cold", outcome: "success" });
  expect(JSON.stringify(entry!.detail)).not.toContain("secret");
});

test("a newer navigation replaces the stage de-duplication state", () => {
  const key = "machine:workspace";
  beginWorkspaceNavigation(key, { client: "tauri-desktop", temperature: "warm" });
  recordWorkspaceNavigation(key, CLIENT_PERFORMANCE_MEASURES.workspaceLayoutReady);
  beginWorkspaceNavigation(key, { client: "tauri-desktop", temperature: "warm" });
  recordWorkspaceNavigation(key, CLIENT_PERFORMANCE_MEASURES.workspaceLayoutReady);

  expect(
    performance.getEntriesByName(CLIENT_PERFORMANCE_MEASURES.workspaceLayoutReady, "measure"),
  ).toHaveLength(2);
});
