import type { WorkspaceDiffEntry, WorkspaceDiffRepository } from "@cloud-machine/client-contracts";

export const workspaceDiffGroupOrder = ["staged", "unstaged", "untracked"] as const;

export type WorkspaceDiffGroup = (typeof workspaceDiffGroupOrder)[number];

export interface WorkspaceDiffTreeFile {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly oldPath?: string;
  readonly entry: WorkspaceDiffEntry;
}

export interface WorkspaceDiffTreeDirectory {
  readonly kind: "directory";
  readonly name: string;
  readonly path: string;
  readonly children: readonly WorkspaceDiffTreeNode[];
}

export type WorkspaceDiffTreeNode = WorkspaceDiffTreeDirectory | WorkspaceDiffTreeFile;

export interface WorkspaceDiffTreeGroup {
  readonly group: WorkspaceDiffGroup;
  readonly count: number;
  readonly children: readonly WorkspaceDiffTreeNode[];
}

export interface WorkspaceDiffRepositoryTree {
  readonly repositoryPath: string;
  /** undefined means that the connected Agent predates repository metadata. */
  readonly remoteUrl?: string | null;
  readonly count: number;
  readonly groups: readonly WorkspaceDiffTreeGroup[];
}

export type WorkspaceGitDecoration = "added" | "modified" | "renamed" | "conflicted";

const decorationPriority: Record<WorkspaceGitDecoration, number> = {
  modified: 0,
  added: 1,
  renamed: 2,
  conflicted: 3,
};

function decorationForEntry(status: WorkspaceDiffEntry["status"]): WorkspaceGitDecoration | null {
  switch (status) {
    case "added":
    case "copied":
    case "untracked":
      return "added";
    case "modified":
      return "modified";
    case "renamed":
      return "renamed";
    case "conflicted":
      return "conflicted";
    case "deleted":
      return null;
  }
}

/** Collapse entries into absolute-path decorations for visible files and all ancestor directories. */
export function buildWorkspaceGitDecorations(
  workspaceRoot: string,
  files: readonly WorkspaceDiffEntry[],
): Readonly<Record<string, WorkspaceGitDecoration>> {
  if (!workspaceRoot.startsWith("/")) return {};
  const root = workspaceRoot === "/" ? "/" : workspaceRoot.replace(/\/+$/, "");
  const decorations: Record<string, WorkspaceGitDecoration> = {};
  const decorate = (path: string, decoration: WorkspaceGitDecoration) => {
    const current = decorations[path];
    if (!current || decorationPriority[decoration] > decorationPriority[current])
      decorations[path] = decoration;
  };
  for (const file of files) {
    const decoration = decorationForEntry(file.status);
    if (!decoration) continue;
    // Nested-repository entries are already prefixed relative to the Workspace root by agentd.
    const path = `${root === "/" ? "" : root}/${file.path}`;
    decorate(path, decoration);
    decorate(root, decoration);
    let parent = root;
    for (const segment of file.path.split("/").slice(0, -1)) {
      parent = parent === "/" ? `/${segment}` : `${parent}/${segment}`;
      decorate(parent, decoration);
    }
  }
  return decorations;
}

interface MutableDirectory {
  name: string;
  path: string;
  directories: Map<string, MutableDirectory>;
  files: WorkspaceDiffTreeFile[];
}

function repositoryRelativePath(path: string, repositoryPath: string): string {
  if (!repositoryPath) return path;
  const prefix = `${repositoryPath}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function buildGroupTree(
  entries: readonly WorkspaceDiffEntry[],
  repositoryPath: string,
): readonly WorkspaceDiffTreeNode[] {
  const root: MutableDirectory = {
    name: "",
    path: "",
    directories: new Map(),
    files: [],
  };
  for (const entry of entries) {
    const path = repositoryRelativePath(entry.path, repositoryPath);
    const parts = path.split("/");
    const name = parts.pop()!;
    let parent = root;
    for (const part of parts) {
      const childPath = parent.path ? `${parent.path}/${part}` : part;
      let child = parent.directories.get(part);
      if (!child) {
        child = { name: part, path: childPath, directories: new Map(), files: [] };
        parent.directories.set(part, child);
      }
      parent = child;
    }
    parent.files.push({
      kind: "file",
      name,
      path,
      ...(entry.oldPath ? { oldPath: repositoryRelativePath(entry.oldPath, repositoryPath) } : {}),
      entry,
    });
  }

  const finish = (directory: MutableDirectory): readonly WorkspaceDiffTreeNode[] => [
    ...[...directory.directories.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child): WorkspaceDiffTreeDirectory => ({
        kind: "directory",
        name: child.name,
        path: child.path,
        children: finish(child),
      })),
    ...directory.files.sort((a, b) => a.name.localeCompare(b.name)),
  ];
  return finish(root);
}

export function buildWorkspaceDiffTree(
  files: readonly WorkspaceDiffEntry[],
  repositoryMetadata: readonly WorkspaceDiffRepository[] = [],
): readonly WorkspaceDiffRepositoryTree[] {
  const repositories = new Map<
    string,
    { entries: WorkspaceDiffEntry[]; remoteUrl?: string | null }
  >();
  for (const repository of repositoryMetadata) {
    repositories.set(repository.repositoryPath ?? "", {
      entries: [],
      remoteUrl: repository.remoteUrl,
    });
  }
  for (const file of files) {
    const repositoryPath = file.repositoryPath ?? "";
    const repository = repositories.get(repositoryPath) ?? { entries: [] };
    repository.entries.push(file);
    repositories.set(repositoryPath, repository);
  }
  return [...repositories.entries()]
    .sort(([left], [right]) => {
      if (!left) return -1;
      if (!right) return 1;
      return left.localeCompare(right);
    })
    .map(([repositoryPath, repository]) => ({
      repositoryPath,
      ...(repository.remoteUrl !== undefined ? { remoteUrl: repository.remoteUrl } : {}),
      count: repository.entries.length,
      groups: workspaceDiffGroupOrder.flatMap((group) => {
        const grouped = repository.entries.filter((entry) => entry.group === group);
        return grouped.length
          ? [{ group, count: grouped.length, children: buildGroupTree(grouped, repositoryPath) }]
          : [];
      }),
    }));
}
