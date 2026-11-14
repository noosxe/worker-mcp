/** A list of log lines that keeps only the most recent `max`. */
export class BoundedLog {
	readonly lines: string[] = [];

	constructor(private readonly max: number) {}

	push(line: string): void {
		this.lines.push(line);
		if (this.lines.length > this.max) {
			this.lines.splice(0, this.lines.length - this.max);
		}
	}
}
