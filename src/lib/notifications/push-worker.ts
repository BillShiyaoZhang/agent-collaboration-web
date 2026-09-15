import { runPushTick } from "./push-store";
type Worker = { stopped: boolean; timer?: ReturnType<typeof setTimeout>; warningAt: number };
const globalWorker = globalThis as typeof globalThis & { __agentPushWorker?: Worker };
export function startPushWorker() {
  if (process.env.WEB_PUSH_DISABLED === "1" || process.env.WORKSPACE_SYNC_DISABLED === "1" || process.env.NEXT_PHASE === "phase-production-build" || globalWorker.__agentPushWorker && !globalWorker.__agentPushWorker.stopped) return;
  const state: Worker = { stopped: false, warningAt: 0 }; globalWorker.__agentPushWorker = state;
  const tick = async () => {
    if (state.stopped) return;
    try { await runPushTick(); } catch { if (Date.now() - state.warningAt > 60000) { console.warn("Web Push will retry; check migration and server configuration."); state.warningAt = Date.now(); } }
    if (!state.stopped) { state.timer = setTimeout(tick, 3000); state.timer.unref?.(); }
  };
  state.timer = setTimeout(tick, 1000); state.timer.unref?.();
}
export function stopPushWorker() { const state = globalWorker.__agentPushWorker; if (state) { state.stopped = true; clearTimeout(state.timer); } }
