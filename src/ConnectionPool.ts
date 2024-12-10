import { type TimeProvider } from "./TimeProvider";
import { HasLogging } from "./debug";

interface Connection {
	uuid: string;
	disconnect: () => void;
	leaseExpiryTime?: number;
}

interface QueuedRequest {
	uuid: string;
	disconnect: () => void;
	lease_s: number;
	resolve: (success: boolean) => void;
}

export class ConnectionPool extends HasLogging {
	private static instance: ConnectionPool;
	private connections: Map<string, Connection>;
	private connectionQueue: QueuedRequest[];
	private queueProcessorInterval: number;

	private constructor(
		private timeProvider: TimeProvider,
		private maxPersistentConnections = 10,
		private maxTemporaryConnections = 6,
	) {
		super();
		this.connections = new Map();
		this.connectionQueue = [];

		this.queueProcessorInterval = this.timeProvider.setInterval(
			() => this.processQueue(),
			1000,
		);
	}

	private isPersistent(connection: Connection): boolean {
		return !connection.leaseExpiryTime;
	}

	private getConnectionCounts(): { persistent: number; temporary: number } {
		let persistent = 0;
		let temporary = 0;

		this.connections.forEach((conn) => {
			if (this.isPersistent(conn)) {
				persistent++;
			} else {
				temporary++;
			}
		});

		return { persistent, temporary };
	}

	private logConnectionStatus(): void {
		const counts = this.getConnectionCounts();
		this.log(`Connection Status:
												Total: ${this.connections.size}
												Persistent: ${counts.persistent}/${this.maxPersistentConnections}
												Temporary: ${counts.temporary}/${this.maxTemporaryConnections}
												Queued: ${this.connectionQueue.length}
												Active connections: ${Array.from(this.connections.keys()).join(", ")}
								`);
	}

	private enforceConnectionLimits(): void {
		const counts = this.getConnectionCounts();

		if (
			counts.persistent > this.maxPersistentConnections ||
			counts.temporary > this.maxTemporaryConnections
		) {
			this.warn(`Connection limits exceeded!
				Persistent: ${counts.persistent}/${this.maxPersistentConnections}
				Temporary: ${counts.temporary}/${this.maxTemporaryConnections}`);

			const connections = Array.from(this.connections.entries()).sort(
				([, a], [, b]) => {
					if (this.isPersistent(a) !== this.isPersistent(b)) {
						return this.isPersistent(a) ? 1 : -1;
					}
					return (a.leaseExpiryTime || 0) - (b.leaseExpiryTime || 0);
				},
			);

			while (
				counts.temporary > this.maxTemporaryConnections &&
				connections.length > 0
			) {
				const [uuid, conn] = connections.shift()!;
				if (!this.isPersistent(conn)) {
					this.releaseConnection(uuid);
					counts.temporary--;
				}
			}

			while (
				counts.persistent > this.maxPersistentConnections &&
				connections.length > 0
			) {
				const [uuid, conn] = connections.shift()!;
				if (this.isPersistent(conn)) {
					this.releaseConnection(uuid);
					counts.persistent--;
				}
			}
		}
	}

	private processQueue(): void {
		const currentTime = this.timeProvider.getTime();
		//this.logConnectionStatus();
		this.enforceConnectionLimits();

		let cleaned = 0;
		for (const [uuid, connection] of this.connections.entries()) {
			if (
				connection.leaseExpiryTime &&
				connection.leaseExpiryTime <= currentTime
			) {
				this.log(`Releasing expired temporary connection: ${uuid}`);
				this.releaseConnection(uuid);
				cleaned++;
			}
		}
		if (cleaned > 0) {
			this.log(`Cleaned up ${cleaned} expired connections`);
			this.logConnectionStatus();
		}

		while (this.connectionQueue.length > 0) {
			const counts = this.getConnectionCounts();
			if (counts.temporary >= this.maxTemporaryConnections) {
				break;
			}

			const request = this.connectionQueue.shift();
			if (!request) continue;

			if (this.connections.has(request.uuid)) {
				request.resolve(true);
				continue;
			}

			this.connections.set(request.uuid, {
				uuid: request.uuid,
				disconnect: request.disconnect,
				leaseExpiryTime: this.timeProvider.getTime() + request.lease_s * 1000,
			});

			this.log(`Created queued temporary connection for ${request.uuid}`);
			request.resolve(true);
		}
	}

	public static initialize(
		timeProvider: TimeProvider,
		maxPersistentConnections = 10,
		maxTemporaryConnections = 6,
	): ConnectionPool {
		if (!ConnectionPool.instance) {
			ConnectionPool.instance = new ConnectionPool(
				timeProvider,
				maxPersistentConnections,
				maxTemporaryConnections,
			);
		}
		return ConnectionPool.instance;
	}

	public static getInstance(): ConnectionPool {
		return ConnectionPool.instance;
	}

	public hasConnection(uuid: string): boolean {
		return this.connections.has(uuid);
	}

	public async requestConnection(
		uuid: string,
		disconnect: () => void,
		lease_s?: number,
	): Promise<boolean> {
		this.log(
			`Connection request - UUID: ${uuid}, Lease: ${lease_s || "persistent"}`,
		);
		this.logConnectionStatus();

		if (this.connections.has(uuid)) {
			return true;
		}

		const counts = this.getConnectionCounts();

		if (!lease_s) {
			if (counts.persistent >= this.maxPersistentConnections) {
				return false;
			}

			this.connections.set(uuid, {
				uuid,
				disconnect,
			});
			this.log(`Created persistent connection for ${uuid}`);
			return true;
		}

		if (counts.temporary < this.maxTemporaryConnections) {
			this.connections.set(uuid, {
				uuid,
				disconnect,
				leaseExpiryTime: this.timeProvider.getTime() + lease_s * 1000,
			});
			this.log(`Created temporary connection for ${uuid}`);
			return true;
		}

		return new Promise((resolve) => {
			this.connectionQueue.push({
				uuid,
				disconnect,
				lease_s,
				resolve,
			});
			this.log(`Queued connection request for ${uuid}`);
		});
	}

	public async requestConnections(
		connections: { uuid: string; disconnect: () => void; lease_s?: number }[],
	): Promise<boolean[]> {
		return Promise.all(
			connections.map(({ uuid, disconnect, lease_s }) =>
				this.requestConnection(uuid, disconnect, lease_s),
			),
		);
	}

	public getQueueLength(): number {
		return this.connectionQueue.length;
	}

	public releaseConnection(uuid: string): void {
		this.log(`Attempting to release connection: ${uuid}`);
		const connection = this.connections.get(uuid);
		if (connection) {
			connection.disconnect();
			this.connections.delete(uuid);
			this.log(`Successfully released connection: ${uuid}`);
			this.logConnectionStatus();
		} else {
			this.warn(`Attempted to release non-existent connection: ${uuid}`);
		}
	}

	public releaseConnections(uuids: string[]): void {
		uuids.forEach((uuid) => this.releaseConnection(uuid));
	}

	public getStatus(): {
		connections: number;
		persistent: number;
		temporary: number;
		queued: number;
	} {
		const counts = this.getConnectionCounts();
		return {
			connections: this.connections.size,
			persistent: counts.persistent,
			temporary: counts.temporary,
			queued: this.connectionQueue.length,
		};
	}

	public destroy(): void {
		if (this.queueProcessorInterval) {
			this.timeProvider.clearInterval(this.queueProcessorInterval);
		}

		this.connectionQueue.forEach((queued) => {
			queued.resolve(false);
		});
		this.connectionQueue = [];

		this.connections.forEach((connection) => {
			connection.disconnect();
		});

		this.connections.clear();
		this.timeProvider = null as any;
		ConnectionPool.instance = null as any;
	}
}
