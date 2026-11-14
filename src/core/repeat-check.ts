/**
 * A cheap check for a worker stuck repeating itself: the same non-blank line
 * many times in a row, or a very long stretch made of one repeated line.
 * Blank lines are skipped, so a Markdown rule or a table separator that
 * appears here and there never counts. Fed with streamed text; it holds one
 * line of state, never the text.
 */
export const MAX_REPEATED_LINES = 200;
export const MAX_REPEATED_BYTES = 64 * 1024;

export class RepeatCheck {
	private partial = "";
	private last: string | null = null;
	private count = 0;
	private bytes = 0;

	/** Add text. Returns true once the output has become a repetition. */
	feed(text: string): boolean {
		this.partial += text;
		let nl: number;
		while ((nl = this.partial.indexOf("\n")) !== -1) {
			const line = this.partial.slice(0, nl);
			this.partial = this.partial.slice(nl + 1);
			if (this.line(line)) return true;
		}
		// A line that never ends cannot be judged here: the size budget covers it.
		if (this.partial.length > MAX_REPEATED_BYTES) this.partial = "";
		return false;
	}

	private line(raw: string): boolean {
		const line = raw.trim();
		if (line === "") return false;
		if (line === this.last) {
			this.count++;
			this.bytes += raw.length + 1;
		} else {
			this.last = line;
			this.count = 1;
			this.bytes = raw.length + 1;
		}
		return this.count > MAX_REPEATED_LINES || this.bytes > MAX_REPEATED_BYTES;
	}

	/** Forget everything: a new message starts. */
	reset(): void {
		this.partial = "";
		this.last = null;
		this.count = 0;
		this.bytes = 0;
	}
}
