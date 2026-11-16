import { describe, expect, test } from "bun:test";
import type { WorkspaceDiffEntry, WorkspaceDiffRepository } from "@cloud-machine/client-contracts";

import { buildWorkspaceDiffTree, buildWorkspaceGitDecorations } from "./workspace-diff-tree";

describe("Workspace diff tree", () => {
  test("groups repositories and Git states into directory-first trees", () => {
    const files: WorkspaceDiffEntry[] = [
      { path: "README.md", group: "unstaged", status: "modified" },
      { path: "src/z.ts", group: "unstaged", status: "modified" },
      { path: "src/a.ts", group: "staged", status: "modified" },
      { path: "src/a.ts", group: "unstaged", status: "modified" },
      { path: "new.txt", group: "untracked", status: "untracked" },
      {
        repositoryPath: "vendor/tool",
        path: "vendor/tool/lib/main.ts",
        oldPath: "vendor/tool/old/main.ts",
        group: "staged",
        status: "renamed",
      },
    ];

    const result = buildWorkspaceDiffTree(files);

    expect(result.map((repository) => repository.repositoryPath)).toEqual(["", "vendor/tool"]);
    expect(result[0]!.groups.map((group) => [group.group, group.count])).toEqual([
      ["staged", 1],
      ["unstaged", 3],
      ["untracked", 1],
    ]);
    expect(result[0]!.groups[1]!.children.map((node) => [node.kind, node.name])).toEqual([
      ["directory", "src"],
      ["file", "README.md"],
    ]);
    expect(result[1]!.groups[0]!.children).toEqual([
      {
        kind: "directory",
        name: "lib",
        path: "lib",
        children: [
          {
            kind: "file",
            name: "main.ts",
            path: "lib/main.ts",
            oldPath: "old/main.ts",
            entry: files[5]!,
          },
        ],
      },
    ]);
  });

  test("returns no repository nodes when there are no changed files", () => {
    expect(buildWorkspaceDiffTree([])).toEqual([]);
  });

  test("adds remote metadata and keeps clean repositories visible", () => {
    const files: WorkspaceDiffEntry[] = [
      { path: "README.md", group: "unstaged", status: "modified" },
    ];
    const repositories: WorkspaceDiffRepository[] = [
      { remoteUrl: "https://git.example.com/team/project.git" },
      { repositoryPath: "packages/clean", remoteUrl: null },
    ];

    expect(buildWorkspaceDiffTree(files, repositories)).toEqual([
      {
        repositoryPath: "",
        remoteUrl: "https://git.example.com/team/project.git",
        count: 1,
        groups: [
          {
            group: "unstaged",
            count: 1,
            children: [
              {
                kind: "file",
                name: "README.md",
                path: "README.md",
                entry: files[0]!,
              },
            ],
          },
        ],
      },
      {
        repositoryPath: "packages/clean",
        remoteUrl: null,
        count: 0,
        groups: [],
      },
    ]);
  });

  test("keeps remote metadata absent for old Agent responses", () => {
    const [repository] = buildWorkspaceDiffTree([
      { path: "README.md", group: "unstaged", status: "modified" },
    ]);

    expect(repository).not.toHaveProperty("remoteUrl");
  });

  test("maps present Git changes to files and every ancestor with the highest-priority status", () => {
    const files: WorkspaceDiffEntry[] = [
      { path: "new.ts", group: "untracked", status: "untracked" },
      { path: "copied.ts", group: "staged", status: "copied" },
      { path: "src/app.ts", group: "staged", status: "added" },
      { path: "src/app.ts", group: "unstaged", status: "modified" },
      {
        repositoryPath: "vendor/tool",
        path: "vendor/tool/main.ts",
        oldPath: "vendor/tool/old.ts",
        group: "staged",
        status: "renamed",
      },
      { path: "conflict.ts", group: "unstaged", status: "modified" },
      { path: "conflict.ts", group: "staged", status: "conflicted" },
      { path: "removed.ts", group: "unstaged", status: "deleted" },
    ];

    expect(buildWorkspaceGitDecorations("/workspace/project/", files)).toEqual({
      "/workspace/project": "conflicted",
      "/workspace/project/new.ts": "added",
      "/workspace/project/copied.ts": "added",
      "/workspace/project/src": "added",
      "/workspace/project/src/app.ts": "added",
      "/workspace/project/vendor": "renamed",
      "/workspace/project/vendor/tool": "renamed",
      "/workspace/project/vendor/tool/main.ts": "renamed",
      "/workspace/project/conflict.ts": "conflicted",
    });
    expect(buildWorkspaceGitDecorations("relative/path", files)).toEqual({});
  });

  test("decorates a slash root without producing duplicate separators", () => {
    const files: WorkspaceDiffEntry[] = [
      { path: "src/app.ts", group: "unstaged", status: "modified" },
    ];

    expect(buildWorkspaceGitDecorations("/", files)).toEqual({
      "/": "modified",
      "/src": "modified",
      "/src/app.ts": "modified",
    });
  });
});
