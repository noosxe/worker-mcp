import * as fs from "node:fs";

/**
 * Make `dir` (and missing parents) a private directory, or throw. Whatever is
 * found is checked with `lstat`, never followed: a symlink, a non-directory, a
 * directory owned by someone else or one with any group or other bit set is
 * refused, so nothing another process could have planted is trusted.
 */
export function ensurePrivateDir(dir: string): void {
	let st = lstatOrNull(dir);
	if (st === null) {
		try {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		} catch (e) {
			// Lost a race: the name appeared first. It is verified below.
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		st = lstatOrNull(dir);
		if (st === null) throw new Error(`${dir} could not be created`);
		// Bits the umask removed from our own new directory.
		if (st.isDirectory() && (st.mode & 0o777) !== 0o700 && owned(st)) {
			fs.chmodSync(dir, 0o700);
			st = fs.lstatSync(dir);
		}
	}
	if (st.isSymbolicLink()) throw new Error(`${dir} is a symbolic link`);
	if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
	if (!owned(st)) throw new Error(`${dir} is not owned by the current user`);
	if ((st.mode & 0o077) !== 0) {
		throw new Error(
			`${dir} has unsafe permissions (${(st.mode & 0o777).toString(8)})`,
		);
	}
}

function owned(st: fs.Stats): boolean {
	return typeof process.getuid !== "function" || st.uid === process.getuid();
}

function lstatOrNull(p: string): fs.Stats | null {
	try {
		return fs.lstatSync(p);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM means the process exists but belongs to someone else.
		return (e as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * Read a regular file of ours without following a symlink, at most `maxBytes`.
 * Returns null when it is missing; throws for anything unsafe or too large.
 */
export function readPrivateFile(file: string, maxBytes: number): string | null {
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile()) throw new Error("not a regular file");
		if (!owned(st)) throw new Error("not owned by the current user");
		if (st.size > maxBytes) throw new Error("too large");
		return fs.readFileSync(fd, "utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/** Write `data` to `file` atomically: a temporary file in the same directory, then rename. */
export function writeFileAtomic(file: string, data: string, tmp: string): void {
	const fd = fs.openSync(
		tmp,
		fs.constants.O_WRONLY |
			fs.constants.O_CREAT |
			fs.constants.O_EXCL |
			fs.constants.O_NOFOLLOW,
		0o600,
	);
	try {
		fs.writeFileSync(fd, data);
		fs.fsyncSync(fd);
	} catch (e) {
		fs.closeSync(fd);
		fs.rmSync(tmp, { force: true });
		throw e;
	}
	fs.closeSync(fd);
	try {
		fs.renameSync(tmp, file);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}
}
