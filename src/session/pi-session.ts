import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";

export type SessionStatus =
	| "IDLE"
	| "RUNNING"
	| "AWAITING_APPROVAL"
	| "CRASHED"
	| "FINISHED";

export interface PendingAction {
	actionId: string;
	tool: string;
	arguments: unknown;
	context: string;
}

export class PiSession {
	public sessionId: string;
	public cwd: string;
	public model: string | undefined;
	public systemPrompt: string | undefined;
	public status: SessionStatus = "IDLE";
	public pendingAction: PendingAction | null = null;
	public logs: string[] = [];
	public history: unknown[] = [];

	private process: ChildProcess | null = null;
	private stdoutBuffer: string = "";
	private resolveCommand: ((value: string) => void) | null = null;
	private rejectCommand: ((reason: Error) => void) | null = null;
	private currentTurnOutput = "";
	private abortTimeout: ReturnType<typeof setTimeout> | null = null;
	private terminating = false;

	constructor(
		sessionId: string,
		cwd: string,
		model?: string,
		systemPrompt?: string,
	) {
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.model = model;
		this.systemPrompt = systemPrompt;
		this.log(`Session initialized for directory: ${cwd}`);
	}

	private log(message: string) {
		const timestamp = new Date().toISOString();
		const formatted = `[${timestamp}] ${message}`;
		this.logs.push(formatted);
		console.error(`[Session ${this.sessionId}] ${formatted}`);
	}

	public async start(): Promise<void> {
		const piPath = process.env.WORKER_MCP_PI_PATH || "pi";

		this.log(
			`Spawning pi subprocess in: ${this.cwd} using executable: ${piPath}`,
		);

		// Check if directory exists
		if (!fs.existsSync(this.cwd)) {
			throw new Error(`Workspace directory does not exist: ${this.cwd}`);
		}

		const args = ["--mode", "rpc"];
		if (this.systemPrompt) {
			args.push("--system-prompt", this.systemPrompt);
		}

		try {
			this.process = spawn(piPath, args, {
				cwd: this.cwd,
				env: { ...process.env },
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (e) {
			this.status = "CRASHED";
			this.log(
				`Failed to spawn process: ${e instanceof Error ? e.message : String(e)}`,
			);
			throw e;
		}

		// spawn() only throws synchronously for invalid arguments; a missing or
		// non-executable binary surfaces as an async 'error' event. Wait for the
		// outcome so a failed spawn is reported to the caller instead of being
		// mistaken for a healthy session.
		const child = this.process;
		try {
			await new Promise<void>((resolve, reject) => {
				const onSpawn = () => {
					child.off("error", onError);
					resolve();
				};
				const onError = (err: Error) => {
					child.off("spawn", onSpawn);
					reject(err);
				};
				child.once("spawn", onSpawn);
				child.once("error", onError);
			});
		} catch (e) {
			this.status = "CRASHED";
			this.process = null;
			this.log(
				`Failed to spawn process: ${e instanceof Error ? e.message : String(e)}`,
			);
			throw new Error(
				`Failed to start pi (${piPath}): ${e instanceof Error ? e.message : String(e)}`,
			);
		}

		this.status = "IDLE";

		// Set up stdout buffering and line splitting
		this.process.stdout?.on("data", (chunk: Buffer) => {
			this.stdoutBuffer += chunk.toString("utf8");
			let boundary = this.stdoutBuffer.indexOf("\n");
			while (boundary !== -1) {
				const line = this.stdoutBuffer.substring(0, boundary).trim();
				this.stdoutBuffer = this.stdoutBuffer.substring(boundary + 1);
				if (line) {
					this.handleStdoutLine(line);
				}
				boundary = this.stdoutBuffer.indexOf("\n");
			}
		});

		// Set up stderr parsing
		this.process.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8").trim();
			if (text) {
				this.log(`[stderr] ${text}`);
			}
		});

		// Handle process exits
		this.process.on("close", (code) => this.handleClose(code));

		this.process.on("error", (err) => {
			this.status = "CRASHED";
			this.log(`Process error event: ${err.message}`);
			this.pendingAction = null;
			if (this.rejectCommand) {
				this.rejectCommand(err);
			}
			this.resolveCommand = null;
			this.rejectCommand = null;
		});

		// Apply model override if specified
		if (this.model) {
			// Split into provider/modelId, default to ollama if not specified
			let provider = "ollama";
			let modelId = this.model;
			const slashIndex = this.model.indexOf("/");
			if (slashIndex !== -1) {
				provider = this.model.substring(0, slashIndex);
				modelId = this.model.substring(slashIndex + 1);
			}

			this.log(`Configuring model: ${provider}/${modelId}`);
			await this.writeRaw({
				type: "set_model",
				provider,
				modelId,
			});
		}
	}

	private handleClose(code: number | null) {
		if (this.terminating) {
			// pi exits non-zero when killed, which is not a crash.
			this.status = "FINISHED";
			this.log(`Process terminated on request (exit code: ${code}).`);
		} else if (code !== 0 && code !== null) {
			this.status = "CRASHED";
			this.log(`Process exited with non-zero code: ${code}`);
		} else {
			this.status = "FINISHED";
			this.log(`Process completed and exited successfully.`);
		}

		this.process = null;
		this.pendingAction = null;
		if (this.resolveCommand) {
			this.resolveCommand("Process terminated");
		}
		this.resolveCommand = null;
		this.rejectCommand = null;
	}

	private handleStdoutLine(line: string) {
		try {
			const obj = JSON.parse(line);
			this.log(`[Event Received] ${JSON.stringify(obj)}`);

			// Store trace in history
			this.history.push(obj);

			// 1. Handle command response resolutions
			if (obj.type === "response") {
				if (obj.success === false) {
					this.log(`Command failed: ${obj.error}`);
					if (this.rejectCommand) {
						this.rejectCommand(new Error(obj.error));
						this.rejectCommand = null;
						this.resolveCommand = null;
						this.status = "IDLE";
					}
				} else {
					// Acknowledgement only: pi echoes a `response` as soon as it accepts
					// the command, long before the agent has done any work. The run is
					// settled by `agent_end`, so nothing is resolved here.
					this.log(`Command acknowledged: ${obj.command}`);
				}
				return;
			}

			// 2. Handle interactive gating requests from Extensions (e.g. confirm UI dialogs)
			if (obj.type === "extension_ui_request") {
				if (obj.method === "confirm") {
					this.status = "AWAITING_APPROVAL";
					this.pendingAction = {
						actionId: obj.id,
						tool: "confirm",
						arguments: {
							title: obj.title,
							message: obj.message,
						},
						context:
							"A tool execution or high-risk operation requires supervisor consent.",
					};
					this.log(
						`[INTERCEPTED] Action ${obj.id} awaiting coordinator approval: ${obj.message}`,
					);
					if (this.resolveCommand) {
						this.resolveCommand(
							`AWAITING_APPROVAL: Intercepted tool call. Action ID: ${obj.id}. Message: ${obj.message}`,
						);
						this.resolveCommand = null;
						this.rejectCommand = null;
					}
				}
				return;
			}

			// 3. Handle turn lifecycle events
			if (obj.type === "turn_start") {
				this.currentTurnOutput = "";
			}

			if (obj.type === "message_update") {
				let delta = "";
				if (
					obj.assistantMessageEvent &&
					typeof obj.assistantMessageEvent.delta === "string"
				) {
					delta = obj.assistantMessageEvent.delta;
				} else if (typeof obj.text === "string") {
					delta = obj.text;
				}

				if (delta) {
					this.currentTurnOutput += delta;
					if (this.detectLoop(this.currentTurnOutput)) {
						this.handleLoopDetected();
					}
				}
			}

			// pi signals completion of a whole run with `agent_end`. `turn_end` fires
			// once per tool-call round, so it cannot be used to settle a command.
			if (obj.type === "agent_end" || obj.type === "agent_settled") {
				this.log(`Agent settled.`);
				if (this.abortTimeout) {
					clearTimeout(this.abortTimeout);
					this.abortTimeout = null;
				}
				if (this.status === "RUNNING") {
					this.status = "IDLE";
					if (this.resolveCommand) {
						this.resolveCommand("Agent finished task run successfully.");
						this.resolveCommand = null;
					}
				}
			}
		} catch (e) {
			this.log(`Failed to parse stdout line: ${line} - Error: ${e}`);
		}
	}

	private writeRaw(obj: object): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.process?.stdin) {
				return reject(new Error("Process not running"));
			}

			const payload = `${JSON.stringify(obj)}\n`;
			this.process.stdin.write(payload, "utf8", (err) => {
				if (err) {
					reject(err);
				} else {
					this.log(`[Command Sent] ${JSON.stringify(obj)}`);
					resolve();
				}
			});
		});
	}

	/** Whether a pi subprocess is actually attached to this session. */
	public isAlive(): boolean {
		return this.process !== null;
	}

	public sendCommand(commandText: string): Promise<string> {
		// Reported before the status check so a session restored from the
		// registry says what to do instead of failing with "Process not running".
		if (!this.isAlive()) {
			throw new Error(
				`Session ${this.sessionId} has no running pi process (status: ${this.status}). Respawn it with spawn_pi_session.`,
			);
		}

		if (this.status !== "IDLE" && this.status !== "FINISHED") {
			throw new Error(
				`Cannot send command when session status is ${this.status}`,
			);
		}

		this.status = "RUNNING";
		const cmdId = `cmd_${Date.now()}`;

		return new Promise((resolve, reject) => {
			this.resolveCommand = resolve;
			this.rejectCommand = reject;

			this.writeRaw({
				id: cmdId,
				type: "prompt",
				message: commandText,
			}).catch((err) => {
				// Never claim IDLE for a session with no process behind it.
				this.status = this.isAlive() ? "IDLE" : "FINISHED";
				reject(err);
			});
		});
	}

	public approveAction(actionId: string): Promise<string> {
		if (
			this.status !== "AWAITING_APPROVAL" ||
			!this.pendingAction ||
			this.pendingAction.actionId !== actionId
		) {
			throw new Error(
				`No pending action matching ID: ${actionId} currently awaiting approval`,
			);
		}

		this.log(`Approving action ${actionId}`);
		this.status = "RUNNING";
		this.pendingAction = null;

		return new Promise((resolve, reject) => {
			this.resolveCommand = resolve;
			this.rejectCommand = reject;

			this.writeRaw({
				type: "extension_ui_response",
				id: actionId,
				confirmed: true,
			}).catch((err) => {
				this.status = "IDLE";
				reject(err);
			});
		});
	}

	public rejectAction(actionId: string, reason?: string): Promise<string> {
		if (
			this.status !== "AWAITING_APPROVAL" ||
			!this.pendingAction ||
			this.pendingAction.actionId !== actionId
		) {
			throw new Error(
				`No pending action matching ID: ${actionId} currently awaiting approval`,
			);
		}

		this.log(`Rejecting action ${actionId} with reason: ${reason || "none"}`);
		this.status = "RUNNING";
		this.pendingAction = null;

		return new Promise((resolve, reject) => {
			this.resolveCommand = resolve;
			this.rejectCommand = reject;

			this.writeRaw({
				type: "extension_ui_response",
				id: actionId,
				confirmed: false,
				value: reason,
			}).catch((err) => {
				this.status = "IDLE";
				reject(err);
			});
		});
	}

	public terminate() {
		this.log("Terminating subprocess...");
		this.terminating = true;
		if (this.abortTimeout) {
			clearTimeout(this.abortTimeout);
			this.abortTimeout = null;
		}
		if (this.process) {
			this.process.kill("SIGTERM");
			this.status = "FINISHED";
			this.process = null;
		}
		this.pendingAction = null;
	}

	private detectLoop(text: string): boolean {
		const len = text.length;
		if (len > 16000) return true; // Safeguard limit
		if (len < 5) return false;

		const maxPatternLen = Math.min(50, Math.floor(len / 2));
		for (let patternLen = 1; patternLen <= maxPatternLen; patternLen++) {
			let minRepetitions = 5;
			if (patternLen === 1) minRepetitions = 20;
			else if (patternLen === 2) minRepetitions = 10;
			else if (patternLen === 3) minRepetitions = 8;

			const requiredLen = patternLen * minRepetitions;
			if (len < requiredLen) continue;

			const pattern = text.slice(-patternLen);
			let isLoop = true;
			for (let i = 1; i < minRepetitions; i++) {
				const start = len - patternLen * (i + 1);
				const end = len - patternLen * i;
				const prevPattern = text.slice(start, end);
				if (prevPattern !== pattern) {
					isLoop = false;
					break;
				}
			}
			if (isLoop) return true;
		}
		return false;
	}

	private handleLoopDetected() {
		this.log("[WARNING] Endless output loop detected! Aborting turn...");

		// Attempt clean abort first
		const abortId = `abort_${Date.now()}`;
		this.writeRaw({
			id: abortId,
			type: "abort",
		}).catch((err) => {
			this.log(`Failed to send abort command: ${err.message}`);
		});

		// Set a timer to forcefully kill the process if it doesn't settle/abort within 2 seconds
		if (!this.abortTimeout) {
			this.abortTimeout = setTimeout(() => {
				this.log(
					"[WARNING] Subprocess failed to abort loop. Force terminating...",
				);
				this.terminate();
				this.status = "CRASHED";
				if (this.rejectCommand) {
					this.rejectCommand(
						new Error("Subprocess terminated due to endless output loop."),
					);
					this.rejectCommand = null;
					this.resolveCommand = null;
				}
				this.abortTimeout = null;
			}, 2000);
		}
	}
}
