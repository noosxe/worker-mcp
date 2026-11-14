import * as fs from "node:fs";
import * as path from "node:path";

/** `p` is `root` or lies inside it. Uses `path.relative`, never a prefix test. */
export function isInside(root: string, p: string): boolean {
	const rel = path.relative(root, p);
	return (
		rel === "" ||
		(rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
	);
}

export interface RealPath {
	/** Absolute, with every existing component resolved through symlinks. */
	abs: string;
	/** A component could not be inspected (not "does not exist"): fail closed. */
	unresolved: boolean;
}

/** Symlinks followed before a path counts as a loop, as the kernel does. */
const MAX_SYMLINKS = 40;

/**
 * Resolve `raw` against `base` the way the operating system would: every
 * symlink on the way is followed (a dangling one too, since writing through it
 * creates its target), and `..` after a symlink goes to the link target's
 * parent. Components that do not exist yet are appended as they are. `base`
 * is made absolute first.
 */
export function realResolve(base: string, raw: string): RealPath {
	let parts = (
		path.isAbsolute(raw) ? raw : `${path.resolve(base)}/${raw}`
	).split("/");
	let current = "/";
	let missing = false;
	let unresolved = false;
	let hops = 0;
	while (parts.length > 0) {
		const part = parts.shift() as string;
		if (part === "" || part === ".") continue;
		if (part === "..") {
			current = path.dirname(current);
			continue;
		}
		const next = path.join(current, part);
		if (missing) {
			current = next;
			continue;
		}
		let isLink = false;
		try {
			isLink = fs.lstatSync(next).isSymbolicLink();
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") unresolved = true;
			missing = true;
			current = next;
			continue;
		}
		if (!isLink) {
			current = next;
			continue;
		}
		let target: string;
		try {
			target = fs.readlinkSync(next);
		} catch {
			unresolved = true;
			missing = true;
			current = next;
			continue;
		}
		if (++hops > MAX_SYMLINKS) {
			// A loop: the path cannot be used, so it is never "inside".
			unresolved = true;
			missing = true;
			current = next;
			continue;
		}
		if (target.startsWith("/")) current = "/";
		parts = [...target.split("/"), ...parts];
	}
	return { abs: current, unresolved };
}

/** A path that cannot be resolved (or does not exist) falls back to lexical. */
export function realOrLexical(p: string): string {
	return realResolve("/", p).abs;
}
