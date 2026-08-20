/** An error whose message is already user-facing; the CLI prints it as `error: <msg>`. */
export class GmsError extends Error {
	readonly hints: string[];

	constructor(message: string, ...hints: string[]) {
		super(message);
		this.name = "GmsError";
		this.hints = hints;
	}
}

export function fail(message: string, ...hints: string[]): never {
	throw new GmsError(message, ...hints);
}
