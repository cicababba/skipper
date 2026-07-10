"use client";

import { createContext, useContext, useEffect, useState } from "react";

// Add-on modules active in this build (e.g. "dev", "anatomize").
// Enabled = compiled into the binary. Outside Electron the bridge is absent
// → no modules, core-only UI.

interface ModulesState {
  has: (id: string) => boolean;
  modules: string[];
  loaded: boolean;
}

const ModulesContext = createContext<ModulesState>({ has: () => false, modules: [], loaded: false });

export function ModulesProvider({ children }: { children: React.ReactNode }) {
  const [modules, setModules] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const mn = typeof window !== "undefined" ? window.nestbrain : undefined;
    if (!mn?.modules) {
      setLoaded(true);
      return;
    }
    let alive = true;
    mn.modules
      .get()
      .then((m) => {
        if (alive) {
          setModules(m);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <ModulesContext.Provider value={{ has: (id) => modules.includes(id), modules, loaded }}>
      {children}
    </ModulesContext.Provider>
  );
}

export function useModules() {
  return useContext(ModulesContext);
}
