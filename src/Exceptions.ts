export class ObsidianLiveException extends Error {
	constructor(message: string) {
		super(message);
		this.name = "System3 Error";
	}
}
