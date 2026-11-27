/** 工作台首页：电脑资源总览与紧凑列表。 */
"use client";

import type { Machine, Plan } from "@cloud-machine/api-client";
import { isMachineRuntimeAvailable } from "@cloud-machine/client-contracts";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Cpu, Gift, HardDrive, Laptop, MemoryStick, Monitor, Plus } from "lucide-react";
import { Link } from "../host";
import { useRouter } from "../host";

import { ConnectionBadge, LifecycleBadge, PowerBadge } from "../components/StatusBadge";
import { ComputeResourcesIcon } from "../components/ComputeResourcesIcon";
import { MachineDeletionNotice } from "../components/MachineDeletionNotice";
import { api } from "../lib/api";
import { planLabel, regionLabel } from "../lib/display-labels";
import { partitionMachineList } from "../lib/machine-list";
import { userErrorMessage } from "../lib/user-error";

export function DashboardPage() {
  const router = useRouter();
  const machinesQuery = useQuery({
    queryKey: ["machines"],
    queryFn: () => api.machines.list(),
    refetchInterval: 5000,
  });
  const plansQuery = useQuery({ queryKey: ["plans"], queryFn: () => api.plans.list() });
  const trialQuery = useQuery({
    queryKey: ["account-trial"],
    queryFn: () => api.account.getTrial(),
  });
  const planById = new Map<string, Plan>((plansQuery.data ?? []).map((plan) => [plan.id, plan]));
  const allMachines = machinesQuery.data ?? [];
  const { visibleMachines: machines, deletingMachines } = partitionMachineList(allMachines);
  const running = machines.filter(isMachineRuntimeAvailable).length;
  const allocatedMemoryGb = machines.reduce((sum, machine) => sum + machine.memoryMb, 0) / 1024;
  const allocatedDiskGb = machines.reduce((sum, machine) => sum + machine.diskGb, 0);
  const openNewMachinePage = () => router.push("/machines/new");
  const prefetchNewMachinePage = () => router.prefetch("/machines/new");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="cm-toolbar min-h-12 shrink-0 gap-2.5 py-2 sm:min-h-9 sm:gap-2 sm:py-0">
        <Monitor size={14} className="text-zinc-500" />
        <h1 className="text-xs font-medium text-zinc-200">电脑</h1>
        <span className="text-[10px] text-zinc-600">{machines.length} 个资源</span>
        <button
          type="button"
          className="cm-button-primary ml-auto"
          onClick={openNewMachinePage}
          onFocus={prefetchNewMachinePage}
          onPointerEnter={prefetchNewMachinePage}
        >
          <Plus size={13} className="shrink-0" aria-hidden="true" />
          新建电脑
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-5">
        {trialQuery.data?.canClaim && (
          <section className="mx-auto mb-4 flex max-w-6xl items-center gap-3 rounded-[var(--cm-card-radius)] border border-emerald-800/60 bg-emerald-950/30 px-4 py-3">
            <Gift size={18} className="shrink-0 text-emerald-400" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-emerald-300">
                新用户可免费试用电脑 {trialQuery.data.durationDays ?? 3} 天
              </p>
              <p className="mt-0.5 text-[10px] text-emerald-300/70">
                需在{" "}
                {trialQuery.data.eligibleUntil
                  ? new Date(trialQuery.data.eligibleUntil).toLocaleString("zh-CN")
                  : "有效期内"}{" "}
                前领取
              </p>
            </div>
            <Link href="/machines/new" className="cm-button-primary shrink-0">
              立即领取
            </Link>
          </section>
        )}
        {!machinesQuery.isPending && !machinesQuery.isError && deletingMachines.length > 0 ? (
          <div className="mx-auto mb-4 max-w-6xl">
            <MachineDeletionNotice count={deletingMachines.length} />
          </div>
        ) : null}
        {machinesQuery.isPending ? null : machinesQuery.isError ? (
          <WorkspaceMessage
            error
            label={userErrorMessage(machinesQuery.error, "加载电脑列表失败，请稍后重试")}
          />
        ) : allMachines.length === 0 ? (
          <EmptyWorkspace onCreate={openNewMachinePage} onPrefetch={prefetchNewMachinePage} />
        ) : machines.length === 0 ? null : (
          <div className="mx-auto max-w-6xl space-y-4">
            <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <Summary
                label="全部电脑"
                value={machines.length}
                icon={<ComputeResourcesIcon size={14} />}
              />
              <Summary label="运行中" value={running} icon={<Laptop size={14} />} />
              <Summary
                label="已分配 CPU"
                value={machines.reduce((sum, machine) => sum + machine.cpu, 0)}
                icon={<Cpu size={14} />}
              />
              <Summary
                label="已分配内存"
                value={`${allocatedMemoryGb} GB`}
                icon={<MemoryStick size={14} />}
              />
              <Summary
                label="已分配硬盘"
                value={`${allocatedDiskGb} GB`}
                icon={<HardDrive size={14} />}
              />
            </section>

            <section className="cm-panel overflow-hidden">
              <div className="flex h-9 items-center border-b border-zinc-800 px-3">
                <span className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
                  所有电脑
                </span>
                <span className="ml-auto text-[10px] text-zinc-600">每 5 秒自动刷新</span>
              </div>
              <div className="divide-y divide-zinc-800 lg:hidden" aria-label="所有电脑">
                {machines.map((machine) => (
                  <MachineCard
                    key={machine.id}
                    machine={machine}
                    plan={planById.get(machine.planId)}
                  />
                ))}
              </div>
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="bg-zinc-950/60 text-[10px] tracking-wide text-zinc-500 uppercase">
                    <tr>
                      <th className="px-3 py-2 font-medium">电脑名称</th>
                      <th className="px-3 py-2 font-medium">规格</th>
                      <th className="px-3 py-2 font-medium">运行状态</th>
                      <th className="px-3 py-2 font-medium">电源</th>
                      <th className="px-3 py-2 font-medium">通信状态</th>
                      <th className="w-10 px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {machines.map((machine: Machine) => {
                      const plan = planById.get(machine.planId);
                      const region = regionLabel(machine.region);
                      const machineHref = machine.readyAt
                        ? `/machines/${machine.id}`
                        : `/machines/${machine.id}/provisioning`;
                      return (
                        <tr key={machine.id} className="group hover:bg-zinc-800/50">
                          <td className="px-3 py-2">
                            <Link
                              href={machineHref}
                              className="flex items-center gap-2 text-zinc-200 group-hover:text-zinc-100"
                            >
                              <span className="flex h-7 w-7 items-center justify-center rounded border border-zinc-800 bg-zinc-950 text-zinc-500">
                                <Laptop size={14} />
                              </span>
                              <span>
                                <span className="block font-medium">{machine.name}</span>
                                {region ? (
                                  <span className="block text-[10px] text-zinc-600">{region}</span>
                                ) : null}
                              </span>
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-zinc-400">
                            {plan
                              ? planLabel(plan.name, {
                                  code: plan.code,
                                  cpu: plan.cpu,
                                  memoryMb: plan.memoryMb,
                                  diskGb: plan.diskGb,
                                })
                              : machine.planId.slice(0, 8)}
                            <span className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-600">
                              <span className="inline-flex items-center gap-1">
                                <Cpu size={10} />
                                {machine.cpu} CPU
                              </span>
                              <span className="inline-flex items-center gap-1">
                                <MemoryStick size={10} />
                                {(machine.memoryMb / 1024).toFixed(0)} GB RAM
                              </span>
                              <span className="inline-flex items-center gap-1">
                                <HardDrive size={10} />
                                {machine.diskGb} GB DISK
                              </span>
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <LifecycleBadge status={machine.lifecycleStatus} />
                          </td>
                          <td className="px-3 py-2">
                            <PowerBadge power={machine.powerState} />
                          </td>
                          <td className="px-3 py-2">
                            <ConnectionBadge state={machine.agentConnectionState} />
                          </td>
                          <td className="px-3 py-2">
                            <Link href={machineHref} className="cm-icon-button" title="打开电脑">
                              <ArrowRight size={13} />
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function MachineCard({ machine, plan }: { machine: Machine; plan?: Plan }) {
  const region = regionLabel(machine.region);
  const machineHref = machine.readyAt
    ? `/machines/${machine.id}`
    : `/machines/${machine.id}/provisioning`;

  return (
    <article className="p-3">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] border border-zinc-800 bg-zinc-950 text-zinc-500">
          <Laptop size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <Link href={machineHref} className="block truncate font-medium text-zinc-100">
            {machine.name}
          </Link>
          <p className="mt-0.5 text-[10px] text-zinc-500">
            {[
              region,
              plan
                ? planLabel(plan.name, {
                    code: plan.code,
                    cpu: plan.cpu,
                    memoryMb: plan.memoryMb,
                    diskGb: plan.diskGb,
                  })
                : machine.planId.slice(0, 8),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <Link href={machineHref} className="cm-icon-button" aria-label={`打开 ${machine.name}`}>
          <ArrowRight size={14} />
        </Link>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-[10px] text-zinc-500">
        <span className="inline-flex items-center gap-1">
          <Cpu size={11} /> {machine.cpu} CPU
        </span>
        <span className="inline-flex items-center gap-1">
          <MemoryStick size={11} /> {(machine.memoryMb / 1024).toFixed(0)} GB RAM
        </span>
        <span className="inline-flex items-center gap-1">
          <HardDrive size={11} /> {machine.diskGb} GB DISK
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <LifecycleBadge status={machine.lifecycleStatus} />
        <PowerBadge power={machine.powerState} />
        <ConnectionBadge state={machine.agentConnectionState} />
      </div>
    </article>
  );
}

function Summary({
  label,
  value,
  icon,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
}) {
  return (
    <div className="cm-panel flex min-h-16 items-center gap-3 px-3 py-2">
      <span className="flex h-7 w-7 items-center justify-center rounded bg-zinc-800 text-zinc-500">
        {icon}
      </span>
      <span>
        <span className="block text-lg font-medium tabular-nums text-zinc-100">{value}</span>
        <span className="block text-[10px] text-zinc-500">{label}</span>
      </span>
    </div>
  );
}

function WorkspaceMessage({ label, error = false }: { label: string; error?: boolean }) {
  return (
    <div
      className={`flex h-full items-center justify-center text-xs ${error ? "text-red-400" : "text-zinc-500"}`}
    >
      {label}
    </div>
  );
}

function EmptyWorkspace({
  onCreate,
  onPrefetch,
}: {
  onCreate: () => void;
  onPrefetch: () => void;
}) {
  return (
    <div className="flex h-full min-h-80">
      <div className="m-auto max-w-sm text-center [@media(min-height:520px)]:-translate-y-[70px]">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-500">
          <Laptop size={22} />
        </span>
        <h2 className="mt-4 text-sm font-medium text-zinc-200">开始你的云端开发</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500">创建一台真正的Linux计算机运行智能体</p>
        <button
          type="button"
          className="cm-button-primary mt-4"
          onClick={onCreate}
          onFocus={onPrefetch}
          onPointerEnter={onPrefetch}
        >
          <Plus size={13} />
          新建第一台电脑
        </button>
      </div>
    </div>
  );
}
