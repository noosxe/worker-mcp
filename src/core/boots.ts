import * as fs from "node:fs";
import * as path from "node:path";

import { type Logger, noopLogger } from "./log.js";
import {
	ensurePrivateDir,
	pidAlive,
	readPrivateFile,
	writeFileAtomic,
} from "./private-dir.js";

const BOOT_ID = /^[a-z0-9]{12}$/;

/**
 * Which server processes sharing a state directory are alive. Each one writes
 * `<dir>/<bootId>` holding its pid when it starts and removes it on a clean
 * exit. A boot is live when that file exists and its pid is running, so one
 * server never treats another's runs or approvals as abandoned while that
 * server is up. A pid in another pid namespace cannot be seen from here, and a
 * reused pid keeps a dead boot looking alive; both only leave records as they
 * were until the next sweep, never wrongly close a live run.
 */
export class BootRegistry {
	constructor(
		readonly dir: string,
		private readonly bootId: string,
		private readonly pid: number = process.pid,
		private readonly log: Logger = noopLogger,
	) {}

	private fileOf(bootId: string): string | null {
		return BOOT_ID.test(bootId) ? path.join(this.dir, bootId) : null;
	}

	/** Make the directory, sweep dead boots and record this one. Throws on failure. */
	register(): void {
		ensurePrivateDir(this.dir);
		this.sweep();
		const file = this.fileOf(this.bootId);
		if (!file) throw new Error("the boot id has an unexpected shape");
		writeFileAtomic(file, `${this.pid}\n`, `${file}.tmp`);
	}

	/** Forget this boot (clean exit). Never throws. */
	unregister(): void {
		const file = this.fileOf(this.bootId);
		if (!file) return;
		try {
			fs.rmSync(file, { force: true });
		} catch {
			// best effort
		}
	}

	/** Whether the server that made `bootId` is running now. This one always is. */
	isLive(bootId: string): boolean {
		if (bootId === this.bootId) return true;
		const file = this.fileOf(bootId);
		if (!file) return false;
		try {
			const text = readPrivateFile(file, 64);
			if (text === null) return false;
			const pid = Number(text.trim());
			return Number.isInteger(pid) && pid > 0 && pidAlive(pid);
		} catch {
			return false;
		}
	}

	/** Remove markers of servers that are gone. */
	sweep(): void {
		let names: string[];
		try {
			names = fs.readdirSync(this.dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (name === this.bootId) continue;
			if (BOOT_ID.test(name) && this.isLive(name)) continue;
			const full = path.join(this.dir, name);
			try {
				const st = fs.lstatSync(full);
				if (!st.isFile()) continue;
				if (BOOT_ID.test(name) || Date.now() - st.mtimeMs > 60_000) {
					fs.rmSync(full, { force: true });
				}
			} catch (e) {
				this.log.debug(`boot marker ${name} not removed: ${String(e)}`);
			}
		}
	}
}
