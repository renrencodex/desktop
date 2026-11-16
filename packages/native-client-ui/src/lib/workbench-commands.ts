export type MachineView = "overview" | "ports" | "snapshots";

export type WorkbenchCommand = { type: "machine.view"; view: MachineView };

export const WORKBENCH_COMMAND_EVENT = "cloud-machine:workbench-command";

export function dispatchWorkbenchCommand(command: WorkbenchCommand): void {
  window.dispatchEvent(
    new CustomEvent<WorkbenchCommand>(WORKBENCH_COMMAND_EVENT, { detail: command }),
  );
}

export function subscribeWorkbenchCommands(
  listener: (command: WorkbenchCommand) => void,
): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<WorkbenchCommand>).detail);
  window.addEventListener(WORKBENCH_COMMAND_EVENT, handler);
  return () => window.removeEventListener(WORKBENCH_COMMAND_EVENT, handler);
}
