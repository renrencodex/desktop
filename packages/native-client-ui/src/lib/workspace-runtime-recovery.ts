import type { Machine, WorkspaceRuntimeState } from "@cloud-machine/api-client";
import { isMachineRuntimeAvailable } from "@cloud-machine/client-contracts";

export const WORKSPACE_RECOVERY_POLL_INTERVAL_MS = 2_000;
export const WORKSPACE_IDLE_POLL_INTERVAL_MS = 15_000;

/** 启动中的电脑需要快速刷新，稳定状态回到低频轮询。 */
export function workspaceMachinePollInterval(
  visible: boolean,
  machine: Machine | undefined,
): number | false {
  if (!visible) return false;
  return machine?.lifecycleStatus === "starting"
    ? WORKSPACE_RECOVERY_POLL_INTERVAL_MS
    : WORKSPACE_IDLE_POLL_INTERVAL_MS;
}

/** 电脑已启动但 Agent/Workspace 尚未就绪时持续快速探测，直至恢复。 */
export function workspaceStatusPollInterval(
  visible: boolean,
  machine: Machine | undefined,
  state: WorkspaceRuntimeState | undefined,
): number | false {
  if (!visible) return false;
  if (
    machine &&
    (machine.lifecycleStatus === "starting" ||
      (isMachineRuntimeAvailable(machine) && (state === undefined || state === "offline")))
  ) {
    return WORKSPACE_RECOVERY_POLL_INTERVAL_MS;
  }
  return WORKSPACE_IDLE_POLL_INTERVAL_MS;
}
