import {
  CLI_STORE_MIN_CONTRACT_VERSION,
  type CliApp,
  type CliInstallation,
  type MachineCliInventory,
} from "@cloud-machine/client-contracts";

export const CLI_STORE_CONNECTION_POLL_INTERVAL_MS = 3_000;
export const CLI_STORE_INVENTORY_POLL_INTERVAL_MS = 15_000;
export const CLI_STORE_OPERATION_POLL_INTERVAL_MS = 2_000;

export function cliStoreInventoryPollInterval(
  active: boolean,
  operation: MachineCliInventory["operation"] | undefined,
): number | false {
  if (!active) return false;
  return operation && ["queued", "running"].includes(operation.state)
    ? CLI_STORE_OPERATION_POLL_INTERVAL_MS
    : CLI_STORE_INVENTORY_POLL_INTERVAL_MS;
}

export function canLaunchCliApp(
  inventory: MachineCliInventory | undefined,
  appId: string,
): boolean {
  if (!inventory?.online) return false;
  return (
    inventory.agentContractVersion !== undefined &&
    inventory.agentContractVersion >= CLI_STORE_MIN_CONTRACT_VERSION &&
    inventory.installations.some(
      (installation) =>
        installation.appId === appId && installation.installed && installation.managed,
    )
  );
}

/** Installed, unlisted apps stay visible without becoming installable again. */
export function mergeCliCatalog(
  catalog: readonly CliApp[],
  installations: readonly CliInstallation[],
): CliApp[] {
  const apps = new Map(catalog.map((app) => [app.id, app]));
  for (const item of installations) {
    if ((item.installed || item.managed) && !apps.has(item.appId))
      apps.set(
        item.appId,
        item.app ?? {
          id: item.appId,
          name: item.appId,
          description: "已安装应用",
          homepage: "https://renrencodex.com",
          version: item.version ?? "unknown",
        },
      );
  }
  return [...apps.values()];
}

const appNameCollator = new Intl.Collator("zh-CN", { sensitivity: "base", numeric: true });

function compareCliAppNames(left: CliApp, right: CliApp): number {
  return (
    appNameCollator.compare(left.name, right.name) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

/** 商店的全部可见应用按名称排序，不修改共享的目录或缓存。 */
export function sortCliAppsByName(apps: readonly CliApp[]): CliApp[] {
  return [...apps].sort(compareCliAppNames);
}

/** 工作区只显示已安装应用，按收据时间排列；缺失/无效时间稳定排在末尾。 */
export function sortInstalledCliApps(
  apps: readonly CliApp[],
  installations: readonly CliInstallation[],
): CliApp[] {
  const installedTimes = new Map<string, number>();
  for (const item of installations) {
    if (!item.installed) continue;
    const time = Date.parse(item.installedAt ?? "");
    installedTimes.set(item.appId, Number.isFinite(time) ? time : Number.POSITIVE_INFINITY);
  }
  return apps
    .filter((app) => installedTimes.has(app.id))
    .sort((left, right) => {
      const leftTime = installedTimes.get(left.id)!;
      const rightTime = installedTimes.get(right.id)!;
      return leftTime === rightTime ? compareCliAppNames(left, right) : leftTime - rightTime;
    });
}
