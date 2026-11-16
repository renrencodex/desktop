/** 轻量 toast 通知：成功/失败的统一反馈通道（Toaster 以 aria-live 播报）。 */
import { create } from "zustand";

export type ToastKind = "success" | "error";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  dismiss: (id: number) => void;
}

let toastSequence = 0;
const TOAST_DURATION: Record<ToastKind, number> = { success: 3000, error: 5000 };
const MAX_TOASTS = 3;

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export function toast(kind: ToastKind, message: string): void {
  const id = ++toastSequence;
  useToastStore.setState((state) => ({
    toasts: [...state.toasts, { id, kind, message }].slice(-MAX_TOASTS),
  }));
  setTimeout(() => useToastStore.getState().dismiss(id), TOAST_DURATION[kind]);
}

export const toastSuccess = (message: string) => toast("success", message);
export const toastError = (message: string) => toast("error", message);
