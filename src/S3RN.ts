// pronounced 'sern', stands for 'System3 Resource Name'

export type UUID = string;

export class System3Resource {
	platform: string = "s3rn";
}

export interface S3Product extends System3Resource {
	product: string;
}

export class S3RelayProduct implements S3Product {
	platform: string = "s3rn";
	product: string = "relay";
}

export class S3Relay {
	platform: string = "s3rn";
	product: string = "relay";

	constructor(public relayId: UUID) {}
}

export class S3RemoteFolder {
	platform: string = "s3rn";
	product: string = "relay";

	constructor(
		public relayId: UUID,
		public folderId: UUID,
	) {}
}

export class S3RemoteDocument {
	platform: string = "s3rn";
	product: string = "relay";

	constructor(
		public relayId: UUID,
		public folderId: UUID,
		public documentId: UUID,
	) {}
}

export class S3RemoteCanvas {
	platform: string = "s3rn";
	product: string = "relay";

	constructor(
		public relayId: UUID,
		public folderId: UUID,
		public canvasId: UUID,
	) {}
}

export class S3RemoteFile {
	platform: string = "s3rn";
	product: string = "relay";

	constructor(
		public relayId: UUID,
		public folderId: UUID,
		public fileId: UUID,
	) {}
}

export class S3RemoteBlob {
	platform: string = "s3rn";
	product: string = "relay";

	constructor(
		public relayId: UUID,
		public folderId: UUID,
		public fileId: UUID,
		public hash: string,
		public contentType: string,
		public contentLength: string,
	) {}
}

export class S3Folder {
	platform: string = "s3rn";
	product: string = "relay";

	constructor(public folderId: UUID) {}
}

export class S3Document {
	platform: string = "s3rn";
	product: string = "relay";

	constructor(
		public folderId: UUID,
		public documentId: UUID,
	) {}
}

export class S3Canvas {
	platform: string = "s3rn";
	product: string = "relay";

	constructor(
		public folderId: UUID,
		public canvasId: UUID,
	) {}
}

export class S3File {
	platform: string = "s3rn";
	product: string = "relay";

	constructor(
		public folderId: UUID,
		public fileId: UUID,
	) {}
}

export type S3RNType =
	| S3RelayProduct
	| S3Relay
	| S3RemoteFolder
	| S3RemoteDocument
	| S3RemoteCanvas
	| S3RemoteFile;

export class S3RN {
	static validateUUID(uuid: UUID): boolean {
		const uuidRegex =
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
		return uuidRegex.test(uuid);
	}

	static encode(entity: S3RNType): string {
		let s3rn = `${entity.platform}:${entity.product}`;

		if ("relayId" in entity) {
			if (!this.validateUUID(entity.relayId)) {
				throw new Error("Invalid relay UUID");
			}
			s3rn += `:relay:${entity.relayId}`;
		}

		if ("folderId" in entity) {
			if (!this.validateUUID(entity.folderId)) {
				throw new Error("Invalid folder UUID");
			}
			s3rn += `:folder:${entity.folderId}`;
		}

		if ("documentId" in entity) {
			if (!this.validateUUID(entity.documentId)) {
				throw new Error("Invalid document UUID");
			}
			s3rn += `:doc:${entity.documentId}`;
		}

		if ("canvasId" in entity) {
			if (!this.validateUUID(entity.canvasId)) {
				throw new Error("Invalid document UUID");
			}
			s3rn += `:canvas:${entity.canvasId}`;
		}

		if ("fileId" in entity) {
			if (!this.validateUUID(entity.fileId)) {
				throw new Error("Invalid document UUID");
			}
			s3rn += `:file:${entity.fileId}`;

			if (
				"hash" in entity &&
				entity.hash &&
				"contentType" in entity &&
				"contentLength" in entity
			) {
				if (!this.validateUUID(entity.fileId)) {
					throw new Error("Invalid document UUID");
				}
				s3rn += `:sha256:${entity.hash}`;
				s3rn += `:contentType:${entity.contentType}`;
				s3rn += `:contentLength:${entity.contentLength}`;
			}
		}

		return s3rn;
	}

	static decode(s3rn: string): S3RNType {
		const parts = s3rn.split(":");
		if (parts.length < 3) {
			throw new Error("Invalid s3rn format");
		}

		const [
			,
			product,
			type0,
			item0,
			type1,
			item1,
			type2,
			item2,
			type3,
			item3,
			type4,
			item4,
			type5,
			item5,
		] = parts;
		if (!this.validateUUID(item0)) {
			throw new Error("Invalid UUID");
		}
		if (item1 && !this.validateUUID(item1)) {
			throw new Error("Invalid UUID");
		}
		if (item2 && !this.validateUUID(item2)) {
			throw new Error("Invalid UUID");
		}

		if (
			product === "relay" &&
			type0 === "relay" &&
			type1 === "folder" &&
			type2 === "doc"
		) {
			return new S3RemoteDocument(item0, item1, item2);
		} else if (
			product === "relay" &&
			type0 === "relay" &&
			type1 === "folder" &&
			type2 === "canvas"
		) {
			return new S3RemoteCanvas(item0, item1, item2);
		} else if (
			product === "relay" &&
			type0 === "relay" &&
			type1 === "folder" &&
			type2 === "file" &&
			type3 === "hash" &&
			type4 === "contentType" &&
			type5 === "contentLength"
		) {
			return new S3RemoteBlob(item0, item1, item2, item3, item4, item5);
		} else if (
			product === "relay" &&
			type0 === "relay" &&
			type1 === "folder" &&
			type2 === "file"
		) {
			return new S3RemoteFile(item0, item1, item2);
		} else if (product === "relay" && type0 === "relay" && type1 == "folder") {
			return new S3RemoteFolder(item0, item1);
		} else if (
			product === "relay" &&
			type0 === "folder" &&
			type1 === "document"
		) {
			return new S3Document(item0, item1);
		} else if (
			product === "relay" &&
			type0 === "folder" &&
			type1 === "canvas"
		) {
			return new S3Canvas(item0, item1);
		} else if (product === "relay" && type0 === "folder") {
			return new S3Folder(item0);
		} else if (product === "relay" && type0 === "relay") {
			return new S3Relay(item0);
		} else if (type0 === undefined) {
			return new S3RelayProduct();
		}
		throw new Error("Invalid s3rn format for the given product type");
	}
}
