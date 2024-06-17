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
	relayId: UUID;

	constructor(relayId: UUID) {
		this.relayId = relayId;
	}
}

export class S3Document {
	platform: string = "s3rn";
	product: string = "relay";
	relayId: UUID;
	documentId: UUID;

	constructor(relayId: UUID, documentId: UUID) {
		this.relayId = relayId;
		this.documentId = documentId;
	}
}

export type S3RNType = S3RelayProduct | S3Relay | S3Document;

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
		if ("documentId" in entity) {
			if (!this.validateUUID(entity.documentId)) {
				throw new Error("Invalid document UUID");
			}
			s3rn += `:doc:${entity.documentId}`;
		}
		return s3rn;
	}

	static decode(s3rn: string): S3RNType {
		const parts = s3rn.split(":");
		if (parts.length < 3) {
			throw new Error("Invalid s3rn format");
		}

		const [, product, type, item, subType, subItem] = parts;
		if (!this.validateUUID(item)) {
			throw new Error("Invalid UUID");
		}
		if (subItem && !this.validateUUID(subItem)) {
			throw new Error("Invalid UUID");
		}

		if (product === "relay" && type === "relay" && subType === "doc") {
			return new S3Document(item, subItem);
		} else if (product === "relay" && type === "relay") {
			return new S3Relay(item);
		} else if (type === undefined) {
			return new S3RelayProduct();
		}
		throw new Error("Invalid s3rn format for the given product type");
	}
}
