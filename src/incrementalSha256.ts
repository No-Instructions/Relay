"use strict";

/**
 * Incremental SHA-256 for content that never fits in memory at once.
 * `crypto.subtle.digest` requires the full buffer, so chunked transfers use
 * node crypto when the runtime provides it and the block implementation
 * below otherwise. Both produce the digest that hashing the identical full
 * buffer produces.
 */

export interface IncrementalHasher {
	update(chunk: Uint8Array): void;
	/** Finalizes the hash; the hasher must not be used afterwards. */
	digestHex(): string;
}

type NodeHash = {
	update(data: Uint8Array): unknown;
	digest(encoding: "hex"): string;
};

function nodeCreateHash(): NodeHash | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const nodeCrypto = (globalThis as any).require?.("crypto");
		if (nodeCrypto?.createHash) {
			return nodeCrypto.createHash("sha256") as NodeHash;
		}
	} catch {
		// Renderer without node integration; use the block implementation.
	}
	return null;
}

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class BlockSha256 implements IncrementalHasher {
	private h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
		0x1f83d9ab, 0x5be0cd19,
	]);
	private block = new Uint8Array(64);
	private blockLen = 0;
	private totalBytes = 0;
	private w = new Uint32Array(64);
	private finished = false;

	update(chunk: Uint8Array): void {
		if (this.finished) throw new Error("hasher already finalized");
		this.totalBytes += chunk.length;
		let offset = 0;
		if (this.blockLen > 0) {
			const take = Math.min(64 - this.blockLen, chunk.length);
			this.block.set(chunk.subarray(0, take), this.blockLen);
			this.blockLen += take;
			offset = take;
			if (this.blockLen === 64) {
				this.processBlock(this.block, 0);
				this.blockLen = 0;
			}
		}
		while (offset + 64 <= chunk.length) {
			this.processBlock(chunk, offset);
			offset += 64;
		}
		if (offset < chunk.length) {
			this.block.set(chunk.subarray(offset), 0);
			this.blockLen = chunk.length - offset;
		}
	}

	digestHex(): string {
		if (this.finished) throw new Error("hasher already finalized");
		this.finished = true;
		const bitLenHi = Math.floor(this.totalBytes / 0x20000000);
		const bitLenLo = (this.totalBytes << 3) >>> 0;
		const pad = new Uint8Array(this.blockLen < 56 ? 64 : 128);
		pad.set(this.block.subarray(0, this.blockLen), 0);
		pad[this.blockLen] = 0x80;
		const view = new DataView(pad.buffer);
		view.setUint32(pad.length - 8, bitLenHi, false);
		view.setUint32(pad.length - 4, bitLenLo, false);
		this.processBlock(pad, 0);
		if (pad.length === 128) this.processBlock(pad, 64);
		let hex = "";
		for (let i = 0; i < 8; i++) {
			hex += this.h[i].toString(16).padStart(8, "0");
		}
		return hex;
	}

	private processBlock(data: Uint8Array, offset: number): void {
		const w = this.w;
		for (let i = 0; i < 16; i++) {
			const j = offset + i * 4;
			w[i] =
				(data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
		}
		for (let i = 16; i < 64; i++) {
			const s0 =
				((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
				((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^
				(w[i - 15] >>> 3);
			const s1 =
				((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
				((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^
				(w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}
		let [a, b, c, d, e, f, g, h] = this.h;
		for (let i = 0; i < 64; i++) {
			const S1 =
				((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
			const S0 =
				((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (S0 + maj) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}
		this.h[0] = (this.h[0] + a) >>> 0;
		this.h[1] = (this.h[1] + b) >>> 0;
		this.h[2] = (this.h[2] + c) >>> 0;
		this.h[3] = (this.h[3] + d) >>> 0;
		this.h[4] = (this.h[4] + e) >>> 0;
		this.h[5] = (this.h[5] + f) >>> 0;
		this.h[6] = (this.h[6] + g) >>> 0;
		this.h[7] = (this.h[7] + h) >>> 0;
	}
}

class NodeSha256 implements IncrementalHasher {
	constructor(private hash: NodeHash) {}
	update(chunk: Uint8Array): void {
		this.hash.update(chunk);
	}
	digestHex(): string {
		return this.hash.digest("hex");
	}
}

export function createIncrementalSha256(): IncrementalHasher {
	const nodeHash = nodeCreateHash();
	return nodeHash ? new NodeSha256(nodeHash) : new BlockSha256();
}
