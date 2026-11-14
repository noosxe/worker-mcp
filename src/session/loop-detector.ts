/**
 * Detects runaway output: text far past the size cap, or a short pattern
 * repeated many times at the end. Pure; the caller decides what to do.
 */
export function detectLoop(text: string, maxOutputChars: number): boolean {
	const len = text.length;
	if (len > maxOutputChars) return true; // Safeguard limit
	if (len < 5) return false;

	const maxPatternLen = Math.min(50, Math.floor(len / 2));
	for (let patternLen = 1; patternLen <= maxPatternLen; patternLen++) {
		let minRepetitions = 5;
		if (patternLen === 1) minRepetitions = 20;
		else if (patternLen === 2) minRepetitions = 10;
		else if (patternLen === 3) minRepetitions = 8;

		const requiredLen = patternLen * minRepetitions;
		if (len < requiredLen) continue;

		const pattern = text.slice(-patternLen);
		let isLoop = true;
		for (let i = 1; i < minRepetitions; i++) {
			const start = len - patternLen * (i + 1);
			const end = len - patternLen * i;
			if (text.slice(start, end) !== pattern) {
				isLoop = false;
				break;
			}
		}
		if (isLoop) return true;
	}
	return false;
}
