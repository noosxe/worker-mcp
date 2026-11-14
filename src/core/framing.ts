/**
 * LF-delimited line framing with a hard cap on line length. Splits on `\n`
 * only (a trailing `\r` is dropped), as pi's RPC mode does. A line longer than
 * the cap is dropped, reported once through `onOverflow`, and the framer
 * resynchronises at the next `\n`, so one bad line never grows the buffer.
 */
export class LineFramer {
	private buffer = "";
	private discarding = false;

	constructor(
		private readonly maxChars: number,
		private readonly onLine: (line: string) => void,
		private readonly onOverflow: (observedChars: number) => void,
	) {}

	push(chunk: string): void {
		let start = 0;
		for (;;) {
			const nl = chunk.indexOf("\n", start);
			if (nl === -1) {
				if (!this.discarding) {
					this.buffer += chunk.slice(start);
					if (this.buffer.length > this.maxChars) {
						this.onOverflow(this.buffer.length);
						this.buffer = "";
						this.discarding = true;
					}
				}
				return;
			}
			const part = chunk.slice(start, nl);
			start = nl + 1;
			if (this.discarding) {
				// The tail of an oversized line, already reported.
				this.discarding = false;
				continue;
			}
			const line = this.buffer + part;
			this.buffer = "";
			if (line.length > this.maxChars) {
				this.onOverflow(line.length);
				continue;
			}
			this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		}
	}

	/** The stream ended: deliver a final line that had no terminator. */
	end(): void {
		if (!this.discarding && this.buffer) {
			const line = this.buffer;
			this.buffer = "";
			this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		}
		this.buffer = "";
		this.discarding = false;
	}
}
