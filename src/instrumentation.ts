export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWorkspaceSync } = await import("./lib/workspace/workspace-sync");
    startWorkspaceSync();
    const { startPushWorker } = await import("./lib/notifications/push-worker");
    startPushWorker();
  }
}
