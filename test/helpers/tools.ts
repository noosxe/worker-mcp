// Type-checked by `tsc -p tsconfig.test.json` (part of `pnpm run lint`).
// The only place that knows tool names. A later rename changes this map.
export const TOOLS = {
	spawn: "spawn_pi_session",
	send: "send_pi_command",
	cancel: "cancel_pi_command",
	terminate: "terminate_pi_session",
	list: "list_pi_sessions",
	pending: "get_pending_actions",
	approve: "approve_action",
	reject: "reject_action",
	setPolicy: "set_risk_policy",
	startRun: "start_run",
	waitRun: "wait_run",
	getRun: "get_run",
	cancelRun: "cancel_run",
} as const;
