// Type-checked by `tsc -p tsconfig.test.json` (part of `pnpm run lint`).
// The only place that knows tool names. A later rename changes this map.
export const TOOLS = {
	spawn: "spawn_worker",
	terminate: "terminate_worker",
	list: "list_workers",
	pending: "get_pending_actions",
	approve: "approve_action",
	reject: "reject_action",
	setPolicy: "set_risk_policy",
	startRun: "start_run",
	waitRun: "wait_run",
	getRun: "get_run",
	cancelRun: "cancel_run",
} as const;
