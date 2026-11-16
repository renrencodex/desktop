/**
 * 认证状态（设计文档 57.12）：access token 只存内存（Zustand），禁 localStorage；
 * 刷新页面由 /auth/refresh（httpOnly cookie）恢复会话（见 lib/session.ts）。
 */
import type { User } from "@cloud-machine/api-client";
import { create } from "zustand";
import { syncMachineTitleAccount } from "../lib/machine-title";
import { syncMachineDetailCacheAccount } from "../lib/machine-detail-cache";
import { machineMetricsCache } from "../lib/machine-metrics-cache";

export type AuthStatus = "booting" | "authenticated" | "unauthenticated";

interface AuthState {
  status: AuthStatus;
  accessToken: string | null;
  user: User | null;
  setAccessToken: (token: string | null) => void;
  setSession: (user: User, accessToken: string) => void;
  markUnauthenticated: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  status: "booting",
  accessToken: null,
  user: null,
  // refresh 重放路径只换 token，不动 status/user。
  setAccessToken: (accessToken) => set({ accessToken }),
  setSession: (user, accessToken) => {
    machineMetricsCache.setAccount(user.id);
    syncMachineTitleAccount(user.id);
    syncMachineDetailCacheAccount(user.id);
    set({ status: "authenticated", user, accessToken });
  },
  markUnauthenticated: () => {
    machineMetricsCache.setAccount(null);
    syncMachineTitleAccount(null);
    syncMachineDetailCacheAccount(null);
    set({ status: "unauthenticated", user: null, accessToken: null });
  },
}));
