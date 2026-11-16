"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import { createPortal } from "react-dom";

interface MobileTitlebarPortalContextValue {
  target: HTMLDivElement | null;
  setTarget: RefCallback<HTMLDivElement>;
}

const MobileTitlebarPortalContext = createContext<MobileTitlebarPortalContextValue>({
  target: null,
  setTarget: () => {},
});

export function MobileTitlebarPortalProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ target, setTarget }), [target]);
  return (
    <MobileTitlebarPortalContext.Provider value={value}>
      {children}
    </MobileTitlebarPortalContext.Provider>
  );
}

export function MobileTitlebarPortalTarget({ className }: { className?: string }) {
  const { setTarget } = useContext(MobileTitlebarPortalContext);
  return <div ref={setTarget} data-mobile-application-view-switcher className={className} />;
}

export function MobileTitlebarPortal({ children }: { children: ReactNode }) {
  const { target } = useContext(MobileTitlebarPortalContext);
  return target ? createPortal(children, target) : null;
}
