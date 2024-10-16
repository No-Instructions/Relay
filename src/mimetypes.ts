const mimeTypes: { [key: string]: string } = {
	md: "text/plain",
	txt: "text/plain",
	json: "application/json",
	js: "application/javascript",
	ts: "application/typescript",
	html: "text/html",
	css: "text/css",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	svg: "image/svg+xml",
	pdf: "application/pdf",
	canvas: "application/json",
};
export function getMimeType(filename: string): string {
	const extension = filename.split(".").pop()?.toLowerCase() || "";
	return mimeTypes[extension] || "application/octet-stream";
}
