/**
 * Adapted from y-websocket
 *
 * https://raw.githubusercontent.com/yjs/y-websocket/master/src/y-websocket.js
 */

import * as Y from "yjs"; // eslint-disable-line
import * as bc from "lib0/broadcastchannel";
import * as time from "lib0/time";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as authProtocol from "y-protocols/auth";
import * as awarenessProtocol from "y-protocols/awareness";
import { Observable } from "lib0/observable";
import * as math from "lib0/math";
import * as url from "lib0/url";
import { decode as decodeCBOR } from "cbor-x";
import { metrics, curryLog } from "../debug";
import type { TimeProvider } from "../TimeProvider";

const providerError = curryLog("[YSweetProvider]", "error");
const providerLog = curryLog("[YSweetProvider]", "log");
const providerDebug = curryLog("[YSweetProvider]", "debug");

export const messageSync = 0;
export const messageQueryAwareness = 3;
export const messageAwareness = 1;
export const messageAuth = 2;
export const messageEvent = 4;
export const messageEventSubscribe = 5;
export const messageEventUnsubscribe = 6;
export const messageQuerySubdocs = 7;
export const messageSubdocs = 8;

const SUBDOC_QUERY_PAGE_SIZE = 100;

export type HandlerFunction = (
	encoder: encoding.Encoder,
	decoder: decoding.Decoder,
	provider: YSweetProvider,
	emitSynced: boolean,
	messageType: number,
) => void;

export type BeforeReconnect = () => Promise<void> | void;

const messageHandlers: Array<HandlerFunction> = [];

messageHandlers[messageSync] = (
	encoder,
	decoder,
	provider,
	emitSynced,
	_messageType,
) => {
	const syncMessageType = decoding.readVarUint(decoder);
	if (
		provider.readOnly &&
		syncMessageType === syncProtocol.messageYjsSyncStep1
	) {
		decoding.readVarUint8Array(decoder);
		return;
	}

	encoding.writeVarUint(encoder, messageSync);
	switch (syncMessageType) {
		case syncProtocol.messageYjsSyncStep1:
			syncProtocol.readSyncStep1(decoder, encoder, provider.doc);
			break;
		case syncProtocol.messageYjsSyncStep2:
			syncProtocol.readSyncStep2(decoder, provider.doc, provider);
			break;
		case syncProtocol.messageYjsUpdate:
			syncProtocol.readUpdate(decoder, provider.doc, provider);
			break;
		default:
			throw new Error("Unknown sync message type");
	}
	if (
		emitSynced &&
		syncMessageType === syncProtocol.messageYjsSyncStep2 &&
		!provider.synced
	) {
		provider.synced = true;
	}
};

messageHandlers[messageQueryAwareness] = (
	encoder,
	_decoder,
	provider,
	_emitSynced,
	_messageType,
) => {
	if (provider.readOnly) {
		return;
	}
	encoding.writeVarUint(encoder, messageAwareness);
	encoding.writeVarUint8Array(
		encoder,
		awarenessProtocol.encodeAwarenessUpdate(
			provider.awareness,
			Array.from(provider.awareness.getStates().keys()),
		),
	);
};

messageHandlers[messageAwareness] = (
	_encoder,
	decoder,
	provider,
	_emitSynced,
	_messageType,
) => {
	awarenessProtocol.applyAwarenessUpdate(
		provider.awareness,
		decoding.readVarUint8Array(decoder),
		provider,
	);
};

messageHandlers[messageAuth] = (
	_encoder,
	decoder,
	provider,
	_emitSynced,
	_messageType,
) => {
	authProtocol.readAuthMessage(decoder, provider.doc, (_ydoc, reason) =>
		permissionDeniedHandler(provider, reason),
	);
};

messageHandlers[messageEvent] = (
	_encoder,
	decoder,
	provider,
	_emitSynced,
	_messageType,
) => {
	const cborLength = decoding.readVarUint(decoder);
	const cborData = decoding.readUint8Array(decoder, cborLength);

	try {
		const eventMessage = decodeCBOR(cborData);

		// Only process if we're subscribed to this event type
		if (provider.eventSubscriptions.has(eventMessage.event_type)) {
			provider.processEvent(eventMessage);
		}
	} catch (error) {
		providerError(`Failed to decode event message: ${error}`);
	}
};

messageHandlers[messageSubdocs] = (
	_encoder,
	decoder,
	provider,
	_emitSynced,
	_messageType,
) => {
	const cborLength = decoding.readVarUint(decoder);
	const cborData = decoding.readUint8Array(decoder, cborLength);

	try {
		const subdocIndex = normalizeSubdocIndex(decodeCBOR(cborData));
		provider.handleSubdocIndex(subdocIndex);
	} catch (error) {
		providerError(`Failed to decode subdoc index: ${error}`);
	}
};

// @todo - this should depend on awareness.outdatedTime
const messageReconnectTimeout = 30000;

/**
 * Reconnect backoff schedule. While intent is connected the provider retries
 * indefinitely — there is no attempt ceiling. The delay grows exponentially
 * from RECONNECT_BASE_DELAY_MS, doubling on each consecutive failure up to
 * RECONNECT_MAX_DELAY_MS. Full jitter spreads a reconnecting fleet so a single
 * server event (deploy, restart, drain) does not produce a synchronized retry
 * storm. A connection that stays open for RECONNECT_STABILITY_MS is treated as
 * healthy and resets the schedule so the next drop recovers quickly.
 */
export const RECONNECT_BASE_DELAY_MS = 300;
export const RECONNECT_MAX_DELAY_MS = 30000;
export const RECONNECT_STABILITY_MS = 30000;

const permissionDeniedHandler = (provider: YSweetProvider, reason: string) =>
	console.warn(`Permission denied to access ${provider.url}.\n${reason}`);

function reconnectDelay(provider: YSweetProvider): number {
	// wsUnsuccessfulReconnects counts closes since the last stable connection,
	// so the first retry after any close uses the base delay (exponent 0).
	const exponent = math.max(0, provider.wsUnsuccessfulReconnects - 1);
	const capped = math.min(
		RECONNECT_BASE_DELAY_MS * math.pow(2, exponent),
		provider.maxBackoffTime,
	);
	// Full jitter: pick uniformly in [0, capped].
	return math.floor(Math.random() * capped);
}

function scheduleReconnect(provider: YSweetProvider): void {
	if (!provider.canReconnect() || provider._reconnectTimeout !== null) {
		return;
	}
	const delay = reconnectDelay(provider);
	metrics.recordNetworkWebSocketConnection("relay", "reconnect");
	providerDebug(
		`[${provider.roomname}] scheduling reconnect #${provider.wsUnsuccessfulReconnects} in ${delay}ms`,
	);
	provider._reconnectTimeout = provider._setTimeout(() => {
		provider._reconnectTimeout = null;
		reconnectAfterRefresh(provider);
	}, delay);
}

function setupReconnect(provider: YSweetProvider): void {
	if (!provider.shouldConnect || provider.ws !== null) {
		return;
	}
	setupWS(provider);
}

function reconnectAfterRefresh(provider: YSweetProvider): void {
	if (!provider.beforeReconnect) {
		setupReconnect(provider);
		return;
	}
	let beforeReconnect: Promise<void> | void;
	try {
		beforeReconnect = provider.beforeReconnect();
	} catch (error) {
		provider.emit("connection-error", [error, provider]);
		provider.wsUnsuccessfulReconnects++;
		scheduleReconnect(provider);
		return;
	}
	Promise.resolve(beforeReconnect)
		.then(() => setupReconnect(provider))
		.catch((error) => {
			provider.emit("connection-error", [error, provider]);
			provider.wsUnsuccessfulReconnects++;
			scheduleReconnect(provider);
		});
}

const readMessage = (
	provider: YSweetProvider,
	buf: Uint8Array,
	emitSynced: boolean,
): encoding.Encoder => {
	const decoder = decoding.createDecoder(buf);
	const encoder = encoding.createEncoder();
	const messageType = decoding.readVarUint(decoder);
	const messageHandler = provider.messageHandlers[messageType];
	if (/** @type {any} */ messageHandler) {
		if (messageType === messageSync) {
			metrics.recordProtocolMessage("sync", "in", buf.length);
		} else if (messageType === messageEvent) {
			metrics.recordProtocolMessage("event", "in", buf.length);
		} else if (messageType === messageSubdocs) {
			metrics.recordProtocolMessage("subdoc_index", "in", buf.length);
		}
		messageHandler(encoder, decoder, provider, emitSynced, messageType);
	} else {
		console.error("Unable to compute message");
	}
	return encoder;
};

const setupWS = (provider: YSweetProvider) => {
	if (provider.shouldConnect && provider.ws === null) {
		const websocket = new provider._WS(provider.url);
		metrics.recordNetworkWebSocketConnection("relay", "attempt");
		websocket.binaryType = "arraybuffer";
		provider.ws = websocket;
		provider.wsconnecting = true;
		provider.wsconnected = false;
		provider.wsConnectStartTime = time.getUnixTime();
		provider.synced = false;

		websocket.onmessage = (event) => {
			if (provider.ws !== websocket) {
				return;
			}
			provider.wsLastMessageReceived = time.getUnixTime();
			const encoder = readMessage(provider, new Uint8Array(event.data), true);
			if (encoding.length(encoder) > 1) {
				websocket.send(encoding.toUint8Array(encoder));
			}
		};
		websocket.onerror = (event) => {
			if (provider.ws !== websocket) {
				return;
			}
			metrics.recordNetworkWebSocketConnection("relay", "error");
			provider.emit("connection-error", [event, provider]);
		};
		websocket.onclose = (event) => {
			if (provider.ws !== websocket) {
				return;
			}
			metrics.recordNetworkWebSocketConnection("relay", "closed");
			provider.emit("connection-close", [event, provider]);
			provider.ws = null;
			provider.wsconnecting = false;
			provider.wsConnectStartTime = 0;
			provider._clearStableTimeout();
			if (provider.wsconnected) {
				provider.wsconnected = false;
				provider.synced = false;
				// update awareness (all users except local left)
				awarenessProtocol.removeAwarenessStates(
					provider.awareness,
					Array.from(provider.awareness.getStates().keys()).filter(
						(client) => client !== provider.doc.clientID,
					),
					provider,
				);
			}
			// Every close counts against the backoff schedule until a
			// connection proves stable: a live drop and a never-opened attempt
			// both grow the delay, so a flapping socket cannot reconnect in a
			// tight loop. The counter resets once a connection holds (onopen
			// arms _stableTimeout).
			provider.wsUnsuccessfulReconnects++;
			provider.emit("status", [
				{
					status: "disconnected",
					intent: provider.intent,
				},
			]);
			// Reconnection continues indefinitely while intent is connected;
			// canReconnect() only stops the schedule when the user disconnects
			// (shouldConnect false) or no url is available.
			if (provider.canReconnect()) {
				scheduleReconnect(provider);
			}
		};
		websocket.onopen = () => {
			if (provider.ws !== websocket) {
				return;
			}
			metrics.recordNetworkWebSocketConnection("relay", "connected");
			provider.wsLastMessageReceived = time.getUnixTime();
			provider.wsconnecting = false;
			provider.wsconnected = true;
			provider.wsConnectStartTime = 0;
			// Don't reset the backoff counter yet — a socket that opens and
			// immediately drops must keep backing off. The counter resets only
			// once the connection has held for RECONNECT_STABILITY_MS.
			provider._armStableTimeout();
			provider.emit("status", [
				{
					status: "connected",
					intent: provider.intent,
				},
			]);
			// always send sync step 1 when connected
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, messageSync);
			syncProtocol.writeSyncStep1(encoder, provider.doc);
			websocket.send(encoding.toUint8Array(encoder));
			// Flush messages that were buffered while disconnected.
			// These are sync update frames that broadcastMessage couldn't
			// send because the WebSocket wasn't ready. The opening sync
			// exchange handles catch-up, while this flush delivers
			// real-time updates that arrived during the disconnect window.
			if (provider._pendingMessages.length > 0) {
				if (provider.readOnly) {
					provider._pendingMessages = [];
				} else {
					for (const pending of provider._pendingMessages) {
						websocket.send(pending);
					}
					provider._pendingMessages = [];
				}
			}
			// Re-subscribe to events after reconnection
			if (provider.eventSubscriptions.size > 0) {
				const eventTypes = Array.from(provider.eventSubscriptions);
				provider.sendEventSubscribe(eventTypes);
			}
			// Query subdoc snapshots after the parent sync handshake completes.
			provider.once("synced", (synced) => {
				if (synced && provider.ws === websocket && provider.onSubdocIndex) {
					provider.sendQuerySubdocs();
				}
			});
			// broadcast local awareness state
			if (provider.awareness.getLocalState() !== null) {
				if (!provider.readOnly) {
					const encoderAwarenessState = encoding.createEncoder();
					encoding.writeVarUint(encoderAwarenessState, messageAwareness);
					encoding.writeVarUint8Array(
						encoderAwarenessState,
						awarenessProtocol.encodeAwarenessUpdate(provider.awareness, [
							provider.doc.clientID,
						]),
					);
					websocket.send(encoding.toUint8Array(encoderAwarenessState));
				}
			}
		};
		provider.emit("status", [
			{
				status: "connecting",
				intent: provider.intent,
			},
		]);
	}
};

const broadcastMessage = (provider: YSweetProvider, buf: ArrayBuffer) => {
	const ws = provider.ws;
	if (provider.wsconnected && ws && ws.readyState === ws.OPEN) {
		ws.send(buf);
	} else {
		// Buffer the message — flushed in onopen when WebSocket connects
		provider._pendingMessages.push(buf);
	}
	if (provider.bcconnected) {
		bc.publish(provider.bcChannel, buf, provider);
	}
};

type WebSocketPolyfillType = {
	new (url: string | URL, protocols?: string | string[] | undefined): WebSocket;
	prototype: WebSocket;
	readonly CLOSED: number;
	readonly CLOSING: number;
	readonly CONNECTING: number;
	readonly OPEN: number;
};

export type YSweetProviderParams = {
	connect?: boolean;
	awareness?: awarenessProtocol.Awareness;
	params?: {
		[x: string]: string;
	};
	WebSocketPolyfill?: WebSocketPolyfillType;
	resyncInterval?: number;
	maxBackoffTime?: number;
	disableBc?: boolean;
	readOnly?: boolean;
	timeProvider?: TimeProvider;
};

export type ConnectionStatus =
	| "connected"
	| "connecting"
	| "disconnected"
	| "unknown";
export type ConnectionIntent = "connected" | "disconnected";

export interface ConnectionState {
	status: ConnectionStatus;
	intent: ConnectionIntent;
}

export interface EventMessage {
	event_id: string;
	event_type: string;
	doc_id: string;
	timestamp: number;
	user?: string;
	metadata?: Record<string, any>;
	update?: Uint8Array;
}

export type EventCallback = (event: EventMessage) => void;

export interface SubdocIndexEntry {
	snapshot: Uint8Array;
	lastSeen?: number;
}

export type SubdocIndex = Record<string, SubdocIndexEntry>;
export type SubdocIndexCallback = (serverIndex: SubdocIndex) => void;
export type SubdocQueryDocIdsProvider = () => string[];

export function normalizeSubdocIndex(rawIndex: unknown): SubdocIndex {
	const index: SubdocIndex = {};
	const rawEntries = readSubdocIndexEntries(readSubdocIndexData(rawIndex));

	for (const [rawDocId, rawEntry] of rawEntries) {
		if (typeof rawDocId !== "string" || rawDocId.length === 0) continue;
		const entry = normalizeSubdocIndexEntry(rawEntry);
		if (entry) {
			index[rawDocId] = entry;
		}
	}

	return index;
}

function readSubdocIndexData(rawIndex: unknown): unknown {
	const data = readSubdocIndexField(rawIndex, "data");
	return data ?? rawIndex;
}

function readSubdocIndexEntries(rawIndex: unknown): Array<[unknown, unknown]> {
	if (rawIndex instanceof Map) {
		return Array.from(rawIndex.entries());
	}
	if (!rawIndex || typeof rawIndex !== "object") {
		return [];
	}
	return Object.entries(rawIndex as Record<string, unknown>);
}

function normalizeSubdocIndexEntry(rawEntry: unknown): SubdocIndexEntry | null {
	const rawBytes = asUint8Array(rawEntry);
	if (rawBytes) {
		return { snapshot: rawBytes };
	}

	const snapshot =
		asUint8Array(readSubdocIndexField(rawEntry, "snapshot")) ??
		asUint8Array(readSubdocIndexField(rawEntry, "state_snapshot")) ??
		asUint8Array(readSubdocIndexField(rawEntry, "stateSnapshot"));
	if (!snapshot) return null;

	const lastSeen = normalizeSubdocLastSeen(
		readSubdocIndexField(rawEntry, "last_seen") ??
			readSubdocIndexField(rawEntry, "lastSeen"),
	);
	const entry: SubdocIndexEntry = { snapshot };
	if (lastSeen !== undefined) entry.lastSeen = lastSeen;
	return entry;
}

function readSubdocIndexField(rawEntry: unknown, field: string): unknown {
	if (rawEntry instanceof Map) {
		return rawEntry.get(field);
	}
	if (!rawEntry || typeof rawEntry !== "object") {
		return undefined;
	}
	return (rawEntry as Record<string, unknown>)[field];
}

function asUint8Array(value: unknown): Uint8Array | null {
	return value instanceof Uint8Array ? value : null;
}

function normalizeSubdocLastSeen(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "bigint") {
		if (
			value >= BigInt(Number.MIN_SAFE_INTEGER) &&
			value <= BigInt(Number.MAX_SAFE_INTEGER)
		) {
			return Number(value);
		}
		return undefined;
	}
	if (value instanceof Date) {
		const timestamp = value.getTime();
		return Number.isFinite(timestamp) ? timestamp : undefined;
	}
	if (typeof value === "string" && value.length > 0) {
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return numeric;
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/**
 * Websocket Provider for Yjs. Creates a websocket connection to sync the shared document.
 * The document name is attached to the provided url. I.e. the following example
 * creates a websocket connection to http://localhost:1234/my-document-name
 *
 * @example
 * import * as Y from 'yjs'
 * import { YSweetProvider } from 'y-websocket'
 * const doc = new Y.Doc()
 * const provider = new YSweetProvider('http://localhost:1234', 'my-document-name', doc)
 * @extends {Observable<string>}
 */
export class YSweetProvider extends Observable<string> {
	maxBackoffTime: number;
	bcChannel: string;
	url: string;
	roomname: string;
	doc: Y.Doc;
	_WS: WebSocketPolyfillType;
	awareness: awarenessProtocol.Awareness;
	wsconnected: boolean;
	wsconnecting: boolean;
	bcconnected: boolean;
	disableBc: boolean;
	wsUnsuccessfulReconnects: number;
	messageHandlers: Array<HandlerFunction>;
	/** Messages buffered while WebSocket was not ready. Flushed on next send. */
	_pendingMessages: ArrayBuffer[];
	_synced: boolean;
	ws: WebSocket | null;
	wsLastMessageReceived: number;
	wsConnectStartTime: number;
	shouldConnect: boolean;
	_resyncInterval: ReturnType<typeof setInterval> | number; // TODO: is setting this to 0 used as null?
	_bcSubscriber: (...args: any[]) => any;
	_updateHandler: (
		arg0: Uint8Array,
		arg1: any,
		arg2: Y.Doc,
		arg3: Y.Transaction,
	) => void;
	_awarenessUpdateHandler: (...args: any[]) => any;
	_unloadHandler: (...args: any[]) => any;
	_checkInterval: ReturnType<typeof setInterval> | number;
	_reconnectTimeout: ReturnType<typeof setTimeout> | null;
	/** Timer that marks a held connection healthy and resets the backoff. */
	_stableTimeout: ReturnType<typeof setTimeout> | null;
	readOnly: boolean;
	eventSubscriptions: Set<string>;
	eventCallbacks: Map<string, EventCallback[]>;
	onSubdocIndex: SubdocIndexCallback | null;
	subdocIndexCallbacks: Set<SubdocIndexCallback>;
	lastSubdocIndex: SubdocIndex | null;
	getSubdocQueryDocIds: SubdocQueryDocIdsProvider | null;
	private _pendingSubdocIndexResponses: number;
	private _pendingSubdocIndex: SubdocIndex | null;
	private _timeProvider: TimeProvider | null;
	beforeReconnect: BeforeReconnect | null;

	_setInterval(
		callback: () => void,
		ms: number,
	): ReturnType<typeof setInterval> {
		return this._timeProvider
			? (this._timeProvider.setInterval(
					callback,
					ms,
				) as unknown as ReturnType<typeof setInterval>)
			: (window.setInterval(
					callback,
					ms,
				) as unknown as ReturnType<typeof setInterval>);
	}

	_clearInterval(timerId: ReturnType<typeof setInterval> | number): void {
		if (this._timeProvider) {
			this._timeProvider.clearInterval(timerId as number);
		} else {
			window.clearInterval(timerId as number);
		}
	}

	_setTimeout(
		callback: () => void,
		ms: number,
	): ReturnType<typeof setTimeout> {
		return this._timeProvider
			? (this._timeProvider.setTimeout(
					callback,
					ms,
				) as unknown as ReturnType<typeof setTimeout>)
			: (window.setTimeout(
					callback,
					ms,
				) as unknown as ReturnType<typeof setTimeout>);
	}

	_clearTimeout(timerId: ReturnType<typeof setTimeout> | number): void {
		if (this._timeProvider) {
			this._timeProvider.clearTimeout(timerId as number);
		} else {
			window.clearTimeout(timerId as number);
		}
	}

	/**
	 * @param serverUrl - server url
	 * @param roomname - room name
	 * @param doc - Y.Doc instance
	 * @param opts - options
	 * @param opts.connect - connect option
	 * @param opts.awareness - awareness protocol instance
	 * @param opts.params - parameters
	 * @param opts.WebSocketPolyfill - WebSocket polyfill
	 * @param opts.resyncInterval - resync interval
	 * @param opts.maxBackoffTime - maximum backoff time
	 * @param opts.disableBc - disable broadcast channel
	 */
	constructor(
		serverUrl: string,
		roomname: string,
		doc: Y.Doc,
		{
			connect = true,
			awareness = new awarenessProtocol.Awareness(doc),
			params = {},
			WebSocketPolyfill = WebSocket,
			resyncInterval = -1,
			maxBackoffTime = RECONNECT_MAX_DELAY_MS,
			disableBc = false,
			readOnly = false,
			timeProvider,
		}: YSweetProviderParams = {},
	) {
		super();
		this._timeProvider = timeProvider ?? null;
		// ensure that url is always ends with /
		while (serverUrl[serverUrl.length - 1] === "/") {
			serverUrl = serverUrl.slice(0, serverUrl.length - 1);
		}
		const encodedParams = url.encodeQueryParams(params);
		this.maxBackoffTime = maxBackoffTime;
		this.bcChannel = serverUrl + "/" + roomname;
		this.url =
			serverUrl +
			"/" +
			roomname +
			(encodedParams.length === 0 ? "" : "?" + encodedParams);
		this.roomname = roomname;
		this.doc = doc;
		this._WS = WebSocketPolyfill;
		this.awareness = awareness;
		this.wsconnected = false;
		this._pendingMessages = [];
		this.wsconnecting = false;
		this.bcconnected = false;
		this.disableBc = disableBc;
		this.wsUnsuccessfulReconnects = 0;
		this.readOnly = readOnly;
		this.messageHandlers = messageHandlers.slice();
		this._synced = false;
		this.ws = null;
		this.wsLastMessageReceived = 0;
		this.wsConnectStartTime = 0;
		this.shouldConnect = connect;
		this.eventSubscriptions = new Set();
		this.eventCallbacks = new Map();
		this.onSubdocIndex = null;
		this.subdocIndexCallbacks = new Set();
		this.lastSubdocIndex = null;
		this.getSubdocQueryDocIds = null;
		this._pendingSubdocIndexResponses = 0;
		this._pendingSubdocIndex = null;
		this.beforeReconnect = null;

		this._resyncInterval = 0;
		if (resyncInterval > 0) {
			this._resyncInterval = this._setInterval(() => {
				if (this.ws && this.ws.readyState === WebSocket.OPEN) {
					// resend sync step 1
					const encoder = encoding.createEncoder();
					encoding.writeVarUint(encoder, messageSync);
					syncProtocol.writeSyncStep1(encoder, doc);
					this.ws.send(encoding.toUint8Array(encoder));
				}
			}, resyncInterval);
		}

		this._bcSubscriber = (data: ArrayBuffer, origin: any) => {
			if (origin !== this) {
				const encoder = readMessage(this, new Uint8Array(data), false);
				if (encoding.length(encoder) > 1) {
					bc.publish(this.bcChannel, encoding.toUint8Array(encoder), this);
				}
			}
		};

		/**
		 * Listens to Yjs updates and sends them to remote peers (ws and broadcastchannel)
		 */
		this._updateHandler = (update: Uint8Array, origin: any) => {
			if (origin !== this) {
				if (this.readOnly) {
					return;
				}
				metrics.recordProtocolMessage("sync", "out", update.length);
				const encoder = encoding.createEncoder();
				encoding.writeVarUint(encoder, messageSync);
				syncProtocol.writeUpdate(encoder, update);
				broadcastMessage(this, encoding.toUint8Array(encoder));
			} else {
				// Skipped because origin === this (our own sync response)
			}
		};

		this.doc.on("update", this._updateHandler as any);

		// TODO: I think we can get more specific with the array types.
		// They are not documented here so we need to do some digging.
		// https://docs.yjs.dev/api/about-awareness
		this._awarenessUpdateHandler = (
			{
				added,
				updated,
				removed,
			}: { added: Array<any>; updated: Array<any>; removed: Array<any> },
			_origin: any,
		) => {
			if (this.readOnly) {
				return;
			}
			const changedClients = added.concat(updated).concat(removed);
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, messageAwareness);
			encoding.writeVarUint8Array(
				encoder,
				awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients),
			);
			broadcastMessage(this, encoding.toUint8Array(encoder));
		};

		this._unloadHandler = () => {
			awarenessProtocol.removeAwarenessStates(
				this.awareness,
				[doc.clientID],
				"window unload",
			);
		};

		if (typeof window !== "undefined") {
			window.addEventListener("unload", this._unloadHandler as any);
		} else if (typeof process !== "undefined") {
			process.on("exit", this._unloadHandler as any);
		}

		awareness.on("update", this._awarenessUpdateHandler);
		this._checkInterval = this._setInterval(() => {
			if (
				this.wsconnected &&
				messageReconnectTimeout <
					time.getUnixTime() - this.wsLastMessageReceived
			) {
				// no message received in a long time - not even your own awareness
				// updates (which are updated every 15 seconds)
				this.ws?.close();
			}
			if (
				this.wsconnecting &&
				this.ws?.readyState === WebSocket.CONNECTING &&
				this.wsConnectStartTime > 0 &&
				messageReconnectTimeout <
					time.getUnixTime() - this.wsConnectStartTime
			) {
				// Connection attempt is stuck in CONNECTING with no transition.
				// Force-close so onclose can run backoff/retry logic.
				this.ws?.close();
			}
		}, messageReconnectTimeout / 10);
		this._reconnectTimeout = null;
		this._stableTimeout = null;
		if (connect) {
			this.connect();
		}
	}

	/**
	 * Arm the stability timer. If the current connection stays open for
	 * RECONNECT_STABILITY_MS, the backoff counter resets so the next drop
	 * recovers from the base delay instead of a grown one.
	 */
	_armStableTimeout(): void {
		this._clearStableTimeout();
		this._stableTimeout = this._setTimeout(() => {
			this._stableTimeout = null;
			if (this.wsUnsuccessfulReconnects !== 0) {
				providerDebug(
					`[${this.roomname}] connection held ${RECONNECT_STABILITY_MS}ms; reset reconnect backoff`,
				);
			}
			this.wsUnsuccessfulReconnects = 0;
		}, RECONNECT_STABILITY_MS);
	}

	_clearStableTimeout(): void {
		if (this._stableTimeout !== null) {
			this._clearTimeout(this._stableTimeout);
			this._stableTimeout = null;
		}
	}

	/**
	 * @type {boolean}
	 */
	get synced() {
		return this._synced;
	}

	set synced(state) {
		if (this._synced !== state) {
			this._synced = state;
			this.emit("synced", [state]);
			this.emit("sync", [state]);
		}
	}

	/**
	 * Override once to handle race condition where synced event already fired
	 */
	once(name: string, f: (...args: any[]) => void) {
		if (name === "synced" && this._synced) {
			queueMicrotask(() => {
				if (this._synced) f(this._synced);
			});
			return this;
		}
		return super.once(name, f);
	}

	/**
	 * Get the current connection intent based on shouldConnect flag
	 */
	get intent(): ConnectionIntent {
		return this.shouldConnect ? "connected" : "disconnected";
	}

	get connectionState(): ConnectionState {
		let status: ConnectionStatus;

		if (this.ws?.readyState === WebSocket.OPEN) {
			status = "connected";
		} else if (this.ws?.readyState === WebSocket.CONNECTING) {
			status = "connecting";
		} else {
			status = "disconnected";
		}

		return {
			status,
			intent: this.intent,
		};
	}

	canReconnect(): boolean {
		// Reconnection is indefinite while intent is connected — there is no
		// attempt ceiling. Only an intentional disconnect (shouldConnect false)
		// or a missing url stops the schedule.
		return !!this.url && this.shouldConnect;
	}

	destroy() {
		if (this._resyncInterval !== 0) {
			this._clearInterval(this._resyncInterval);
		}
		this._clearInterval(this._checkInterval);
		if (this._reconnectTimeout !== null) {
			this._clearTimeout(this._reconnectTimeout);
			this._reconnectTimeout = null;
		}
		this._clearStableTimeout();

		if (this.ws) {
			this.ws.onopen = null;
			this.ws.onmessage = null;
			this.ws.onerror = null;
			this.ws.onclose = null;
			if (
				this.ws.readyState === WebSocket.OPEN ||
				this.ws.readyState === WebSocket.CONNECTING
			) {
				this.ws.close(1000, "Destroyed");
			}
			this.ws = null;
		}

		this.disconnect();
		this.awareness.destroy();
		this._observers.clear();
		this.subdocIndexCallbacks.clear();
		this.onSubdocIndex = null;
		this.getSubdocQueryDocIds = null;
		this.lastSubdocIndex = null;

		if (typeof window !== "undefined") {
			window.removeEventListener("unload", this._unloadHandler as any);
			window.clearInterval(this.awareness._checkInterval);
		} else if (typeof process !== "undefined") {
			process.off("exit", this._unloadHandler as any);
		}
		this.awareness.off("update", this._awarenessUpdateHandler);
		this.doc.off("update", this._updateHandler);
		super.destroy();
	}

	connectBc() {
		if (this.disableBc) {
			return;
		}
		if (!this.bcconnected) {
			bc.subscribe(this.bcChannel, this._bcSubscriber as any);
			this.bcconnected = true;
		}
		// send sync step1 to bc
		// write sync step 1
		const encoderSync = encoding.createEncoder();
		encoding.writeVarUint(encoderSync, messageSync);
		syncProtocol.writeSyncStep1(encoderSync, this.doc);
		bc.publish(this.bcChannel, encoding.toUint8Array(encoderSync), this);
		if (!this.readOnly) {
			// broadcast local state
			const encoderState = encoding.createEncoder();
			encoding.writeVarUint(encoderState, messageSync);
			syncProtocol.writeSyncStep2(encoderState, this.doc);
			bc.publish(this.bcChannel, encoding.toUint8Array(encoderState), this);
		}
		// write queryAwareness
		const encoderAwarenessQuery = encoding.createEncoder();
		encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness);
		bc.publish(
			this.bcChannel,
			encoding.toUint8Array(encoderAwarenessQuery),
			this,
		);
		// broadcast local awareness state
		const encoderAwarenessState = encoding.createEncoder();
		encoding.writeVarUint(encoderAwarenessState, messageAwareness);
		encoding.writeVarUint8Array(
			encoderAwarenessState,
			awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
				this.doc.clientID,
			]),
		);
		bc.publish(
			this.bcChannel,
			encoding.toUint8Array(encoderAwarenessState),
			this,
		);
	}

	disconnectBc() {
		if (this.readOnly) {
			if (this.bcconnected) {
				bc.unsubscribe(this.bcChannel, this._bcSubscriber as any);
				this.bcconnected = false;
			}
			return;
		}
		// broadcast message with local awareness state set to null (indicating disconnect)
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, messageAwareness);
		encoding.writeVarUint8Array(
			encoder,
			awarenessProtocol.encodeAwarenessUpdate(
				this.awareness,
				[this.doc.clientID],
				new Map(),
			),
		);
		broadcastMessage(this, encoding.toUint8Array(encoder));
		if (this.bcconnected) {
			bc.unsubscribe(this.bcChannel, this._bcSubscriber as any);
			this.bcconnected = false;
		}
	}

	disconnect() {
		const hadSocket = this.ws !== null;
		this.shouldConnect = false;
		this.wsconnected = false;
		this.wsconnecting = false;
		this.wsConnectStartTime = 0;
		this.synced = false;
		if (this._reconnectTimeout !== null) {
			this._clearTimeout(this._reconnectTimeout);
			this._reconnectTimeout = null;
		}
		this._clearStableTimeout();
		this.disconnectBc();
		if (this.ws !== null) {
			this.ws.close();
			this.ws = null;
		}
		if (hadSocket) {
			// websocket.onclose ignores sockets the provider no longer owns,
			// so an intentional disconnect announces the closure itself.
			this.emit("connection-close", [
				{ code: 1000, reason: "client disconnect", wasClean: true },
				this,
			]);
		}
	}

	setReadOnly(readOnly: boolean) {
		this.readOnly = readOnly;
		if (readOnly) {
			this._pendingMessages = [];
		}
	}

	connect() {
		const wasDisconnected = !this.shouldConnect;
		this.shouldConnect = true;
		if (this._reconnectTimeout !== null) {
			return;
		}
		if (!this.wsconnected && this.ws === null) {
			// An explicit connect after an intentional disconnect starts a
			// fresh retry budget so the first attempt fires without backoff.
			if (wasDisconnected) {
				this.wsUnsuccessfulReconnects = 0;
			}
			setupWS(this);
			this.connectBc();
		}
	}

	/**
	 * Refresh the connection token and update URL if needed
	 * @param serverUrl - new server URL (base URL)  
	 * @param roomname - room/document ID
	 * @param token - new token
	 * @returns whether the URL actually changed
	 */
	refreshToken(
		serverUrl: string,
		roomname: string,
		token: string,
		readOnly?: boolean,
	): { urlChanged: boolean; newUrl: string } {
		if (readOnly !== undefined) {
			this.setReadOnly(readOnly);
		}
		// ensure that url is always ends with /
		while (serverUrl[serverUrl.length - 1] === "/") {
			serverUrl = serverUrl.slice(0, serverUrl.length - 1);
		}
		const params = { token };
		const encodedParams = url.encodeQueryParams(params);
		const newUrl =
			serverUrl +
			"/" +
			roomname +
			(encodedParams.length === 0 ? "" : "?" + encodedParams);

		const urlChanged = this.url !== newUrl;
		
		if (urlChanged) {
			this.url = newUrl;
			this.wsUnsuccessfulReconnects = 0;

			// Close existing connection if it exists
			if (this.ws) {
				this.ws.close();
			}
		}

		return { urlChanged, newUrl };
	}

	hasUrl(expectedUrl: string): boolean {
		return this.url === expectedUrl;
	}

	subscribeToEvents(eventTypes: string[], callback: EventCallback) {
		eventTypes.forEach(type => {
			this.eventSubscriptions.add(type);

			if (!this.eventCallbacks.has(type)) {
				this.eventCallbacks.set(type, []);
			}
			this.eventCallbacks.get(type)!.push(callback);
		});

		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.sendEventSubscribe(eventTypes);
		}
	}

	unsubscribeFromEvents(eventTypes: string[], callback?: EventCallback) {
		eventTypes.forEach(type => {
			if (callback && this.eventCallbacks.has(type)) {
				const callbacks = this.eventCallbacks.get(type)!;
				const index = callbacks.indexOf(callback);
				if (index > -1) {
					callbacks.splice(index, 1);
				}
				if (callbacks.length === 0) {
					this.eventSubscriptions.delete(type);
					this.eventCallbacks.delete(type);
				}
			} else {
				this.eventSubscriptions.delete(type);
				this.eventCallbacks.delete(type);
			}
		});

		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.sendEventUnsubscribe(eventTypes);
		}
	}

	sendEventSubscribe(eventTypes: string[]) {
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, messageEventSubscribe);
		encoding.writeVarUint(encoder, eventTypes.length);

		eventTypes.forEach(type => {
			encoding.writeVarString(encoder, type);
		});

		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(encoding.toUint8Array(encoder));
		}
	}

	sendEventUnsubscribe(eventTypes: string[]) {
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, messageEventUnsubscribe);
		encoding.writeVarUint(encoder, eventTypes.length);

		eventTypes.forEach(type => {
			encoding.writeVarString(encoder, type);
		});

		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(encoding.toUint8Array(encoder));
		}
	}

	processEvent(eventMessage: EventMessage) {
		this.emit('event', [eventMessage]);

		const callbacks = this.eventCallbacks.get(eventMessage.event_type) || [];
		callbacks.forEach(callback => {
			try {
				callback(eventMessage);
			} catch (error) {
				providerError(`Event callback error: ${error}`);
			}
		});
	}

	subscribeToSubdocIndex(callback: SubdocIndexCallback): () => void {
		this.subdocIndexCallbacks.add(callback);
		return () => {
			this.subdocIndexCallbacks.delete(callback);
		};
	}

	sendQuerySubdocs(docIds?: string[]) {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			const queryDocIds = Array.from(
				new Set((docIds ?? this.getSubdocQueryDocIds?.() ?? []).filter(Boolean)),
			);
			if (queryDocIds.length === 0) {
				providerLog("skipped MSG_QUERY_SUBDOCS (no doc IDs)");
				return;
			}
			const pageCount = Math.ceil(queryDocIds.length / SUBDOC_QUERY_PAGE_SIZE);
			this._pendingSubdocIndexResponses = pageCount > 1 ? pageCount : 0;
			this._pendingSubdocIndex = pageCount > 1 ? {} : null;
			for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
				const pageDocIds = queryDocIds.slice(
					pageIndex * SUBDOC_QUERY_PAGE_SIZE,
					(pageIndex + 1) * SUBDOC_QUERY_PAGE_SIZE,
				);
				const encoder = encoding.createEncoder();
				encoding.writeVarUint(encoder, messageQuerySubdocs);
				encoding.writeVarUint(encoder, pageDocIds.length);
				pageDocIds.forEach((docId) => {
					encoding.writeVarString(encoder, docId);
				});
				this.ws.send(encoding.toUint8Array(encoder));
				providerLog(`sent MSG_QUERY_SUBDOCS (${pageDocIds.length})`);
			}
		}
	}

	handleSubdocIndex(serverIndex: SubdocIndex) {
		if (this._pendingSubdocIndexResponses > 0) {
			this._pendingSubdocIndex = {
				...(this._pendingSubdocIndex ?? {}),
				...serverIndex,
			};
			this._pendingSubdocIndexResponses -= 1;
			if (this._pendingSubdocIndexResponses > 0) {
				providerLog(
					`received MSG_SUBDOCS page (${Object.keys(serverIndex).length} docs; waiting for ${this._pendingSubdocIndexResponses} pages)`,
				);
				return;
			}
			const mergedIndex = this._pendingSubdocIndex;
			this._pendingSubdocIndex = null;
			this.notifySubdocIndex(mergedIndex ?? {});
			return;
		}
		this.notifySubdocIndex(serverIndex);
	}

	private notifySubdocIndex(serverIndex: SubdocIndex) {
		this.lastSubdocIndex = serverIndex;
		const entries = Object.values(serverIndex);
		const snapshotCount = entries.filter((entry) => entry.snapshot).length;
		providerLog(
			`received MSG_SUBDOCS (${entries.length} docs; ${snapshotCount} snapshots)`,
		);
		this.onSubdocIndex?.(serverIndex);
		for (const callback of Array.from(this.subdocIndexCallbacks)) {
			try {
				callback(serverIndex);
			} catch (error) {
				providerError(`Subdoc index callback error: ${error}`);
			}
		}
	}

}
