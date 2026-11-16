/** Return whether a path is the selected file/directory or a child of that directory. */
export function pathMatches(path: string, root: string, isDir: boolean): boolean {
  return path === root || (isDir && path.startsWith(`${root}/`));
}

/**
 * Reconcile open editor items after a successful move.
 *
 * When overwrite is explicit, stale tabs under the destination are removed first so
 * remapping the source cannot leave two tabs with the same path.
 */
export function remapItemsAfterMove<T extends { path: string }>(
  items: T[],
  from: string,
  to: string,
  isDir: boolean,
  overwrite: boolean,
): T[] {
  return items
    .filter(
      (item) =>
        !overwrite || pathMatches(item.path, from, isDir) || !pathMatches(item.path, to, isDir),
    )
    .map((item) => ({
      ...item,
      path: remapMovedItemPath(item.path, from, to, isDir),
    }));
}

export function upsertOwnedItem<T extends { path: string; ownerExplorerIds: string[] }>(
  items: T[],
  candidate: T,
  explorerId: string,
): T[] {
  const existing = items.find((item) => item.path === candidate.path);
  if (!existing) return [...items, candidate];
  if (existing.ownerExplorerIds.includes(explorerId)) return items;
  return items.map((item) =>
    item.path === candidate.path
      ? { ...item, ownerExplorerIds: [...item.ownerExplorerIds, explorerId] }
      : item,
  );
}

/** 所有者资源管理器仍存活时保留已读缓冲，避免切换文件时丢掉干净内容再重新读盘。 */
export function reconcileOwnedItems<T extends { path: string; ownerExplorerIds: string[] }>(
  items: T[],
  liveExplorerIds: ReadonlySet<string>,
): T[] {
  return items.flatMap((item) => {
    const ownerExplorerIds = item.ownerExplorerIds.filter((id) => liveExplorerIds.has(id));
    if (ownerExplorerIds.length === 0) return [];
    return ownerExplorerIds.length === item.ownerExplorerIds.length
      ? [item]
      : [{ ...item, ownerExplorerIds }];
  });
}

/**
 * 工作台切到终端/浏览器时 active editor 会暂时为 null；此时保留
 * 上一个仍打开的编辑缓冲，避免 Monaco 反复销毁、重建模型。保留项仅用于
 * 维持 Monaco 生命周期，不能在所选路径不同的情况下作为当前文件展示。
 */
export function selectRetainedEditorItem<T extends { path: string }>(
  items: readonly T[],
  activeItem: T | null,
  retainedPath: string | null,
): T | null {
  return activeItem ?? items.find((item) => item.path === retainedPath) ?? items[0] ?? null;
}

/** 新文件加载完成前不展示保留的旧 model，避免旧内容短暂冒充新文件。 */
export function selectVisibleEditorItem<T extends { path: string }>(
  activeItem: T | null,
  selectedPath: string | null,
): T | null {
  return activeItem?.path === selectedPath ? activeItem : null;
}

function remapMovedItemPath(path: string, from: string, to: string, isDir: boolean): string {
  if (path === from) return to;
  if (isDir && path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return path;
}
