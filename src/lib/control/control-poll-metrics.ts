/** Timings for one control GET. Never put request or account data in this object. */
export type ControlPollTimings = {
  sharedPoll?: boolean;
  mqRetrieveMs?: number;
  mqHttpMs?: number;
  responseDbMs?: number;
  workspaceProjectionMs?: number;
  acknowledgeMs?: number;
};

export type ControlGetTimings = ControlPollTimings & {
  totalMs: number;
  sessionMs?: number;
  identityDbMs?: number;
  controlDbMs?: number;
  pollMs?: number;
  routeProjectionMs?: number;
  resultDecodeMs?: number;
  failed?: boolean;
};

const duration = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

/** Explicit field allowlist keeps identifiers and payloads out of operational logs. */
export function slowControlPollMetric(timing: ControlGetTimings) {
  if (!Number.isFinite(timing.totalMs) || timing.totalMs < 2000) return null;
  const projectionMs = timing.workspaceProjectionMs === undefined && timing.routeProjectionMs === undefined
    ? undefined : (timing.workspaceProjectionMs ?? 0) + (timing.routeProjectionMs ?? 0);
  return {
    event: "slow_control_poll",
    total_ms: duration(timing.totalMs),
    session_ms: duration(timing.sessionMs),
    identity_db_ms: duration(timing.identityDbMs),
    control_db_ms: duration(timing.controlDbMs),
    poll_ms: duration(timing.pollMs),
    mq_retrieve_ms: duration(timing.mqRetrieveMs),
    mq_http_ms: duration(timing.mqHttpMs),
    response_db_ms: duration(timing.responseDbMs),
    workspace_projection_ms: duration(projectionMs),
    acknowledge_ms: duration(timing.acknowledgeMs),
    result_decode_ms: duration(timing.resultDecodeMs),
    shared_poll: timing.sharedPoll === true,
    failed: timing.failed === true,
  };
}
