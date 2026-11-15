/** Test helper: the text inside every `<worker_output>` wrapper, unwrapped. */
export function unwrap(text: string): string {
	return text.replace(
		/<worker_output (?:run|worker)="[^"]*" trust="untrusted">([\s\S]*?)<\/worker_output>/g,
		"$1",
	);
}
