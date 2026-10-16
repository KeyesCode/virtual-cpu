import { useEffect, useState, useSyncExternalStore } from 'react';
import { DashboardStore, type DashboardSnapshot } from './dashboardStore';

/**
 * The dashboard's debug session: one store per mounted dashboard (so one per browser tab), read
 * through `useSyncExternalStore`. Pass `create` to supply the store (tests inject a scheduler).
 */
export function useDebugSession(
  create: () => DashboardStore = () => new DashboardStore(),
): [DashboardSnapshot, DashboardStore] {
  const [store] = useState(create);
  useEffect(
    () => () => {
      store.dispose();
    },
    [store],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return [snapshot, store];
}
