import { createHash } from "node:crypto";

import { ConfigError, type Config } from "../config.js";
import { AuditFile } from "./audit.js";
import { DecisionCache } from "./cache.js";
import { HttpClassifier } from "./http-classifier.js";
import { readTokenFile, TokenFileError } from "./token-file.js";

export interface GateServicesOptions {
	/** The server's version, sent in the classifier's User-Agent. */
	version?: string;
	/** Diagnostics; never given a token. */
	log?: (message: string) => void;
}

/**
 * What the gates of all workers share: the classifiers (with their breakers
 * and tokens), the verdict cache and the audit file. One per server.
 */
export class GateServices {
	readonly classifiers: HttpClassifier[] = [];
	readonly cache: DecisionCache;
	readonly audit: AuditFile | null;
	/** Changes when the classifier configuration does. */
	readonly configVersion: string;
	/** Bearer tokens by classifier name: read from files, kept only here. */
	private readonly tokens = new Map<string, string>();
	private readonly tokenFiles: { name: string; file: string }[] = [];
	private readonly log: (message: string) => void;

	/**
	 * Throws a `ConfigError` when a classifier's token file is missing or not
	 * private enough. Classifiers exist only in `auto` mode.
	 */
	constructor(
		private readonly config: Config,
		opts: GateServicesOptions = {},
	) {
		this.log = opts.log ?? ((m) => console.error(m));
		const gate = config.gate;
		this.cache = new DecisionCache(gate.cache);
		this.configVersion = createHash("sha256")
			.update(JSON.stringify(gate.classifiers))
			.digest("hex")
			.slice(0, 16);
		this.audit = config.audit.enabled
			? new AuditFile({
					file: config.audit.file,
					onError: (e) =>
						this.log(
							`worker-mcp: cannot write the audit log ${config.audit.file}: ${e.message}. Decisions continue; list_workers shows auditDegraded.`,
						),
				})
			: null;
		if (gate.mode !== "auto") return;
		for (const c of gate.classifiers) {
			if (c.tokenFile !== undefined) {
				this.tokenFiles.push({ name: c.name, file: c.tokenFile });
				try {
					this.tokens.set(c.name, readTokenFile(c.tokenFile));
				} catch (e) {
					throw new ConfigError(
						`Invalid config: gate.classifiers ${c.name}.tokenFile: ${e instanceof TokenFileError ? e.message : String(e)}`,
					);
				}
			}
			this.classifiers.push(
				new HttpClassifier(c, {
					token: () => this.tokens.get(c.name),
					version: opts.version,
				}),
			);
		}
	}

	/** Token files that SIGHUP re-reads. */
	get hasTokenFiles(): boolean {
		return this.tokenFiles.length > 0;
	}

	/**
	 * Re-read every token file (after a secret was rotated). A file that has
	 * become unreadable or insecure keeps its old token, and is reported.
	 */
	reloadTokens(): { reloaded: number; failed: number } {
		let reloaded = 0;
		let failed = 0;
		for (const { name, file } of this.tokenFiles) {
			try {
				this.tokens.set(name, readTokenFile(file));
				reloaded++;
			} catch (e) {
				failed++;
				this.log(
					`worker-mcp: keeping the old token of classifier ${name}: ${e instanceof TokenFileError ? e.message : "cannot read the token file"}`,
				);
			}
		}
		return { reloaded, failed };
	}

	/** Whether the audit file could not be written. */
	get auditDegraded(): boolean {
		return this.audit?.degraded ?? false;
	}

	close(): void {
		this.audit?.close();
	}
}
