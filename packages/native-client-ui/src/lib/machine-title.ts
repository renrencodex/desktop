export const MACHINE_TITLE_CACHE_KEY = "cloud-machine.machine-titles.v1";
export const MACHINE_TITLE_ACCOUNT_KEY = "cloud-machine.title-account.v1";
const TITLE_READY_EVENT = "cm-machine-title-ready";

// Also serialized into the head script: keep this parser independent of module state.
export function cachedMachineName(
  serialized: string | null,
  accountId: string | null,
  machineId: string,
  now = Date.now(),
): string | null {
  try {
    if (!serialized || !accountId) return null;
    const cache = JSON.parse(serialized);
    if (
      !cache ||
      cache.accountId !== accountId ||
      typeof cache.updatedAt !== "number" ||
      !Number.isFinite(cache.updatedAt) ||
      now < cache.updatedAt ||
      now - cache.updatedAt > 86400000 ||
      !cache.names ||
      typeof cache.names !== "object" ||
      Array.isArray(cache.names) ||
      !Object.hasOwn(cache.names, machineId)
    )
      return null;
    const name = cache.names[machineId];
    return typeof name === "string" && name.trim() && name.length <= 128 ? name.trim() : null;
  } catch {
    return null;
  }
}

export function syncMachineTitleAccount(accountId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    const previous = window.localStorage.getItem(MACHINE_TITLE_ACCOUNT_KEY);
    const serialized = window.sessionStorage.getItem(MACHINE_TITLE_CACHE_KEY);
    let cacheAccount: unknown;
    try {
      cacheAccount = serialized ? JSON.parse(serialized)?.accountId : accountId;
    } catch {
      cacheAccount = null;
    }
    if (!accountId || previous !== accountId || cacheAccount !== accountId) {
      window.sessionStorage.removeItem(MACHINE_TITLE_CACHE_KEY);
      const machineId = /^\/machines\/([^/]+)(?:\/|$)/.exec(window.location.pathname)?.[1];
      if (machineId && machineId !== "new") document.title = "人人Codex";
    }
    if (accountId) window.localStorage.setItem(MACHINE_TITLE_ACCOUNT_KEY, accountId);
    else window.localStorage.removeItem(MACHINE_TITLE_ACCOUNT_KEY);
  } catch {
    // Storage is optional; never prevent authentication when it is unavailable.
  }
}

export function cacheMachineNames(
  accountId: string,
  machines: ReadonlyArray<{ id: string; name: string }>,
): void {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(MACHINE_TITLE_ACCOUNT_KEY) !== accountId) return;
    const names = Object.fromEntries(
      machines
        .filter((machine) => machine.name.trim() && machine.name.length <= 128)
        .slice(0, 200)
        .map((machine) => [machine.id, machine.name.trim()]),
    );
    window.sessionStorage.setItem(
      MACHINE_TITLE_CACHE_KEY,
      JSON.stringify({ accountId, updatedAt: Date.now(), names }),
    );
  } catch {
    // Private browsing / storage limits fall back to the live API title.
  }
}

export function readMachineTitleName(accountId: string, machineId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    if (window.localStorage.getItem(MACHINE_TITLE_ACCOUNT_KEY) !== accountId) return null;
    return cachedMachineName(
      window.sessionStorage.getItem(MACHINE_TITLE_CACHE_KEY),
      accountId,
      machineId,
    );
  } catch {
    return null;
  }
}

export function finishMachineTitleBootstrap(): void {
  document.dispatchEvent(new Event(TITLE_READY_EVENT));
}

// No imported state: this function runs before React and authentication restoration.
function bootstrapMachineTitle(
  cacheKey: string,
  accountKey: string,
  readyEvent: string,
  readName: typeof cachedMachineName,
) {
  const path = window.location.pathname;
  const machineId = /^\/machines\/([^/]+)(?:\/|$)/.exec(path)?.[1];
  if (!machineId || machineId === "new") return;
  let appliedTitle: string | null = null;
  const apply = () => {
    if (window.location.pathname !== path) {
      stop();
      return;
    }
    try {
      const name = readName(
        window.sessionStorage.getItem(cacheKey),
        window.localStorage.getItem(accountKey),
        machineId,
      );
      if (name) {
        appliedTitle = `${name} · 人人Codex`;
        if (document.title !== appliedTitle) document.title = appliedTitle;
      } else if (appliedTitle && document.title === appliedTitle) {
        document.title = "人人Codex";
      }
    } catch {
      // Storage access may be denied.
    }
  };
  const observer = new MutationObserver(apply);
  const stop = () => {
    observer.disconnect();
    document.removeEventListener(readyEvent, stop);
    window.removeEventListener("storage", apply);
  };
  document.addEventListener(readyEvent, stop, { once: true });
  window.addEventListener("storage", apply);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  apply();
}

export const MACHINE_TITLE_BOOTSTRAP_SCRIPT = `(${bootstrapMachineTitle.toString()})(${JSON.stringify(MACHINE_TITLE_CACHE_KEY)},${JSON.stringify(MACHINE_TITLE_ACCOUNT_KEY)},${JSON.stringify(TITLE_READY_EVENT)},(${cachedMachineName.toString()}));`;
