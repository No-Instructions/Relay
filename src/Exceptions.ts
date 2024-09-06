export class RelayException extends Error {
	constructor(message: string) {
		super(message);
		this.name = "[System3] Relay Error";
	}
}
