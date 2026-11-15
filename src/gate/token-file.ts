import * as fs from "node:fs";

/**
 * Why a token file must not be used, or null. It has to be a regular file
 * (found through any symlink: a sops-nix secret is a symlink to a 0400 file),
 * owned by the user running the server, and not readable or writable by
 * group or others. `uid` is the current user, or null where there is none.
 */
export function tokenFileProblem(
	stat: { mode: number; uid: number; isFile(): boolean },
	uid: number | null,
): string | null {
	if (!stat.isFile()) return "is not a regular file";
	if (uid !== null && stat.uid !== uid) {
		return "is not owned by the user running the server";
	}
	if ((stat.mode & 0o077) !== 0) {
		return "is accessible to group or others (use mode 0600 or 0400)";
	}
	return null;
}

export class TokenFileError extends Error {
	override name = "TokenFileError";
}

/**
 * Read a bearer token from a file. The error names the file, never the
 * contents.
 */
export function readTokenFile(file: string): string {
	let fd: number | undefined;
	try {
		// statSync and open both follow symlinks: the target is what counts.
		fd = fs.openSync(file, fs.constants.O_RDONLY);
		const stat = fs.fstatSync(fd);
		const uid = typeof process.getuid === "function" ? process.getuid() : null;
		const problem = tokenFileProblem(stat, uid);
		if (problem) throw new TokenFileError(`token file ${file} ${problem}`);
		const token = fs.readFileSync(fd, "utf8").trim();
		if (token === "") throw new TokenFileError(`token file ${file} is empty`);
		if (/[\r\n\0]/.test(token)) {
			throw new TokenFileError(`token file ${file} holds more than one line`);
		}
		return token;
	} catch (e) {
		if (e instanceof TokenFileError) throw e;
		throw new TokenFileError(
			`cannot read token file ${file} (${(e as NodeJS.ErrnoException).code ?? "error"})`,
		);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}
