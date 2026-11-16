import { expect, test } from "bun:test";
import {
  CLI_STORE_INVENTORY_POLL_INTERVAL_MS,
  CLI_STORE_OPERATION_POLL_INTERVAL_MS,
  canLaunchCliApp,
  cliStoreInventoryPollInterval,
  mergeCliCatalog,
  sortCliAppsByName,
  sortInstalledCliApps,
} from "./cli-catalog";
import {
  cliInventorySchema,
  type CliApp,
  type CliInstallation,
} from "@cloud-machine/client-contracts";

const cliTestApp: CliApp = {
  id: "codex",
  name: "Codex",
  description: "Test CLI application",
  homepage: "https://example.com/codex",
  version: "1.0.0",
};
const app = (id: string, name: string): CliApp => ({ ...cliTestApp, id, name });
const installation = (appId: string, installedAt?: string | null): CliInstallation => ({
  appId,
  installed: true,
  managed: true,
  installedAt,
  version: "1",
  error: null,
});

test("商店按名称、数字及同名 ID 稳定排序，包含下架应用且不改写输入", () => {
  const catalog = Object.freeze([
    app("tool-ten", "Tool 10"),
    app("codex-z", "codex"),
    app("tool-two", "Tool 2"),
    app("codex-a", "Codex"),
  ]);
  const unlisted = { ...installation("alpha"), app: app("alpha", "Alpha") };
  const merged = mergeCliCatalog(catalog, [unlisted]);
  const initialOrder = merged.map(({ id }) => id);
  const sorted = sortCliAppsByName(Object.freeze(merged));
  expect(sorted.map(({ id }) => id)).toEqual([
    "alpha",
    "codex-a",
    "codex-z",
    "tool-two",
    "tool-ten",
  ]);
  expect(merged.map(({ id }) => id)).toEqual(initialOrder);
  expect(sortCliAppsByName([...merged].reverse())).toEqual(sorted);
});

test("工作区按安装时间而非目录/名称/库存顺序排列，跨时区比较且只保留已安装应用", () => {
  const catalog = Object.freeze([
    app("alpha", "Alpha"),
    app("zulu", "Zulu"),
    app("absent", "Absent"),
  ]);
  const installations = Object.freeze([
    installation("alpha", "2026-10-07T01:00:00Z"),
    { ...installation("absent", "2026-01-01T00:00:00Z"), installed: false },
    installation("zulu", "2026-10-07T08:00:00+08:00"),
    { ...installation("unlisted", "2026-10-07T00:30:00Z"), app: app("unlisted", "Unlisted") },
  ]);
  const merged = mergeCliCatalog(catalog, installations);
  const expected = ["zulu", "unlisted", "alpha"];
  expect(sortInstalledCliApps(merged, installations).map(({ id }) => id)).toEqual(expected);
  expect(
    sortInstalledCliApps([...merged].reverse(), [...installations].reverse()).map(({ id }) => id),
  ).toEqual(expected);
  expect(merged.map(({ id }) => id)).toEqual(["alpha", "zulu", "absent", "unlisted"]);
  expect(sortCliAppsByName(merged).map(({ id }) => id)).toEqual([
    "absent",
    "alpha",
    "unlisted",
    "zulu",
  ]);
});

test("相同时间按名称/ID 兜底，缺失、null 和无效时间统一在末尾，手动安装不猜测时间", () => {
  const apps = [
    app("legacy", "Legacy"),
    app("zulu", "Zulu"),
    app("same-b", "Same"),
    app("same-a", "same"),
    app("manual", "Alpha"),
    app("invalid", "Invalid"),
  ];
  const time = "2026-10-07T00:00:00Z";
  const inventory = [
    installation("same-b", time),
    installation("same-a", time),
    installation("zulu", time),
    installation("legacy"),
    installation("invalid", "not-a-date"),
    { ...installation("manual", null), managed: false },
  ];
  const sorted = sortInstalledCliApps(apps, inventory);
  expect(sorted.map(({ id }) => id)).toEqual([
    "same-a",
    "same-b",
    "zulu",
    "manual",
    "invalid",
    "legacy",
  ]);
  expect(sortInstalledCliApps([...apps].reverse(), [...inventory].reverse())).toEqual(sorted);
});

test("卸载后从工作区移除，重装排到最后；版本变化不改变安装位置", () => {
  const apps = [app("alpha", "Alpha"), app("zulu", "Zulu")];
  const first = installation("alpha", "2026-10-01T00:00:00Z");
  const second = installation("zulu", "2026-10-02T00:00:00Z");
  const ids = (items: CliInstallation[]) => sortInstalledCliApps(apps, items).map(({ id }) => id);
  expect(ids([{ ...first, version: "2" }, second])).toEqual(["alpha", "zulu"]);
  expect(ids([{ ...first, installed: false }, second])).toEqual(["zulu"]);
  expect(ids([{ ...first, installedAt: "2026-10-03T00:00:00Z" }, second])).toEqual([
    "zulu",
    "alpha",
  ]);
  expect(sortInstalledCliApps(apps, [])).toEqual([]);
});

test("异常时间经 DTO 降级后只将该应用后移，不影响正常应用的安装顺序", () => {
  const apps = [app("alpha", "Alpha"), app("beta", "Beta"), app("zulu", "Zulu")];
  const inventory = cliInventorySchema.parse({
    supported: true,
    installations: [
      installation("alpha", "2016-12-31T23:59:60.000Z"),
      installation("beta", "2026-10-02T00:00:00.000Z"),
      installation("zulu", "2026-10-01T00:00:00.000Z"),
    ],
  });
  expect(inventory.installations[0]?.installedAt).toBeNull();
  expect(sortInstalledCliApps(apps, inventory.installations).map(({ id }) => id)).toEqual([
    "zulu",
    "beta",
    "alpha",
  ]);
});

test("unlisting keeps installed metadata and a fourth app never needs a built-in ID or icon", () => {
  const old = cliTestApp;
  const fourth = { ...old, id: "fourth-app", name: "Fourth" };
  const rows = mergeCliCatalog(
    [fourth],
    [
      {
        appId: old.id,
        installed: true,
        managed: true,
        version: old.version,
        error: null,
        app: old,
      },
    ],
  );
  expect(rows.map((app) => app.name)).toEqual(["Fourth", "Codex"]);
  expect(
    mergeCliCatalog(
      [],
      [{ appId: "unknown-app", installed: true, managed: true, version: "1", error: null }],
    )[0]?.name,
  ).toBe("unknown-app");
});

test("an unlisted managed app remains visible when its installation is damaged", () => {
  expect(
    mergeCliCatalog(
      [],
      [
        {
          appId: "future-agent",
          installed: false,
          installSupported: true,
          managed: true,
          version: null,
          error: "应用安装记录损坏",
        },
      ],
    ),
  ).toEqual([
    {
      id: "future-agent",
      name: "future-agent",
      description: "已安装应用",
      homepage: "https://renrencodex.com",
      version: "unknown",
    },
  ]);
});
test("launch capability requires contract v13 and a matching managed installation", () => {
  const inventory = {
    supported: true,
    online: true,
    verifiedAt: null,
    operation: null,
    installations: [
      {
        appId: "codex",
        installed: true,
        managed: true,
        version: "latest",
        error: null,
      },
    ],
  };
  expect(canLaunchCliApp({ ...inventory, agentContractVersion: 9 }, "codex")).toBe(false);
  expect(canLaunchCliApp({ ...inventory, agentContractVersion: 12 }, "codex")).toBe(false);
  expect(canLaunchCliApp({ ...inventory, agentContractVersion: 13 }, "codex")).toBe(true);
  expect(
    canLaunchCliApp(
      {
        ...inventory,
        agentContractVersion: 13,
        installations: [{ ...inventory.installations[0]!, managed: false }],
      },
      "codex",
    ),
  ).toBe(false);
  expect(canLaunchCliApp({ ...inventory, agentContractVersion: 13 }, "fourth-agent")).toBe(false);
  expect(canLaunchCliApp({ ...inventory, online: false, agentContractVersion: 13 }, "codex")).toBe(
    false,
  );
});

test("inventory polling stays low-frequency except while an operation is active", () => {
  const operation = {
    operationId: "operation-1",
    appId: "codex",
    action: "install" as const,
    state: "running" as const,
    stage: "installing" as const,
    output: [],
    error: null,
    updatedAt: new Date().toISOString(),
    cancelRequested: false,
    cancelled: false,
  };

  expect(cliStoreInventoryPollInterval(false, operation)).toBe(false);
  expect(cliStoreInventoryPollInterval(true, null)).toBe(CLI_STORE_INVENTORY_POLL_INTERVAL_MS);
  expect(cliStoreInventoryPollInterval(true, operation)).toBe(CLI_STORE_OPERATION_POLL_INTERVAL_MS);
  expect(
    cliStoreInventoryPollInterval(true, { ...operation, state: "completed", stage: "completed" }),
  ).toBe(CLI_STORE_INVENTORY_POLL_INTERVAL_MS);
});
