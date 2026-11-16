/**
 * 机器运行时能力是生命周期与电源状态的组合：运行中创建普通快照时，
 * lifecycle 为 snapshotting，但 VM 仍保持开机，Workspace / Terminal / Preview 应继续可用。
 */
export function isMachineRuntimeAvailable(machine: {
  lifecycleStatus: string;
  powerState: string;
}): boolean {
  return (
    machine.lifecycleStatus === "running" ||
    (machine.lifecycleStatus === "snapshotting" && machine.powerState === "on")
  );
}
