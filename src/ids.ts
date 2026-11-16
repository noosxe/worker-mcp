import { randomBytes } from "node:crypto";

/** Ids are made by the server, never taken from a caller. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function token(length: number): string {
	const bytes = randomBytes(length);
	let out = "";
	for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
	return out;
}

/** Characters of an id's random part that name the server that made it. */
const TAG_LENGTH = 4;

export type IdKind = "worker" | "run" | "approval";

const PREFIX: Record<IdKind, string> = {
	worker: "w_",
	run: "r_",
	approval: "a_",
};

/**
 * One server process. It has a random boot id and a start time, and the first
 * four characters of every id it makes are a tag taken from the boot id, so
 * an id that this process did not make can be told from one that expired. The
 * id patterns are unchanged: the tag only uses characters they already allow.
 * Nothing here is written to disk.
 */
export class Boot {
	/** Random, 12 lowercase letters or digits; the server's identity until it exits. */
	readonly id: string;
	/** When this server started, in milliseconds since the epoch. */
	readonly startedAt: number;
	private readonly tag: string;

	constructor(now: () => number = Date.now) {
		this.id = token(12);
		this.tag = this.id.slice(0, TAG_LENGTH);
		this.startedAt = now();
	}

	get startedAtIso(): string {
		return new Date(this.startedAt).toISOString();
	}

	/** A worker id: `w_`, the tag and 4 lowercase letters or digits. */
	workerId = (): string => `w_${this.tag}${token(4)}`;

	/** An approval id: `a_`, the tag and 6 lowercase letters or digits. */
	approvalId = (): string => `a_${this.tag}${token(6)}`;

	/** A run id: `r_`, the tag and 12 letters or digits. */
	runId = (): string =>
		`r_${this.tag}${randomBytes(12).toString("base64url").replace(/[-_]/g, "x").slice(0, 12)}`;

	/**
	 * Whether `id` was made by another server process: it has the shape of an
	 * id of this kind and the tag is not this server's. An id that carries
	 * this server's tag but is unknown has expired or never existed.
	 */
	madeByEarlierServer(kind: IdKind, id: string): boolean {
		const prefix = PREFIX[kind];
		if (!id.startsWith(prefix) || id.length < prefix.length + TAG_LENGTH) {
			return false;
		}
		return id.slice(prefix.length, prefix.length + TAG_LENGTH) !== this.tag;
	}

	/** What to tell a caller whose id (or name) this server does not know. */
	restartNote(): string {
		return `worker-mcp keeps no workers or approvals across a restart (a run is kept only as a saved record, when run records are on), so work that was in progress is lost. Check the workspace (git status, git diff) before redoing anything, then spawn a new worker.`;
	}

	/** The sentence for an id made by another server process. */
	notIssuedHere(what: string): string {
		return `${what} was not issued by the server running now (boot ${this.id}, started ${this.startedAtIso}); it comes from an earlier server process. ${this.restartNote()}`;
	}
}

export const WORKER_ID_PATTERN = /^w_[a-z0-9]{8}$/;
/** A caller-chosen label for a worker. Never used in a file path. */
export const WORKER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
