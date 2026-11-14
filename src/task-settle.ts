import type { TaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";

type TaskResult = {
	content: { type: "text"; text: string }[];
	isError?: boolean;
};

/**
 * Stores each task's result at most once. A task can be cancelled, expire or
 * be terminated while its command is still running, and the task store throws
 * when a result is stored for a task that is already terminal or gone. Every
 * store call is guarded so none of those races can become an unhandled
 * rejection.
 */
export class TaskSettler {
	private settled = new Set<string>();

	constructor(private store: Pick<TaskStore, "storeTaskResult">) {}

	/** Returns true if this call stored the result. */
	async settle(
		taskId: string,
		status: "completed" | "failed",
		result: TaskResult,
	): Promise<boolean> {
		if (this.settled.has(taskId)) return false;
		this.settled.add(taskId);
		try {
			await this.store.storeTaskResult(taskId, status, result);
			return true;
		} catch (err) {
			console.error(
				`Could not store result for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	}

	isSettled(taskId: string): boolean {
		return this.settled.has(taskId);
	}
}
