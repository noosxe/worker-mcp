import { randomBytes } from "node:crypto";

/** Ids are made by the server, never taken from a caller. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function token(length: number): string {
	const bytes = randomBytes(length);
	let out = "";
	for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
	return out;
}

/** A worker id: `w_` and 8 lowercase letters or digits. */
export const newWorkerId = (): string => `w_${token(8)}`;

/** An approval id: `a_` and 10 lowercase letters or digits. */
export const newApprovalId = (): string => `a_${token(10)}`;

export const WORKER_ID_PATTERN = /^w_[a-z0-9]{8}$/;
/** A caller-chosen label for a worker. Never used in a file path. */
export const WORKER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
