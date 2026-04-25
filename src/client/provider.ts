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

const providerError = curryLog("[YSweetProvider]", "error");

export const messageSync = 0;
export const messageQueryAwareness = 3;
export const messageAwareness = 1;
export const messageAuth = 2;
export const messageEvent = 4;
export const messageEventSubscribe = 5;
export const messageEventUnsubscribe = 6;
export const messageQuerySubdocs = 7;
export const messageSubdocs = 8;

export type HandlerFunction = (
	encoder: encoding.Encoder,
	decoder: decoding.Decoder,
	provider: YSweetProvider,
	emitSynced: boolean,
	messageType: number,
) => void;

const messageHandlers: Array<HandlerFunction> = [];

messageHandlers[messageSync] = (
	encoder,
	decoder,
	provider,
	emitSynced,
	_messageType,
) => {
	encoding.writeVarUint(encoder, messageSync);
	const syncMessageType = syncProtocol.readSyncMessage(
		decoder,
		encoder,
		provider.doc,
		provider,
	);
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
		providerError(`Failed to decode subdoc state vector index: ${error}`);
	}
};

// @todo - this should depend on awareness.outdatedTime
const messageReconnectTimeout = 30000;

const permissionDeniedHandler = (provider: YSweetProvider, reason: string) =>
	console.warn(`Permission denied to access ${provider.url}.\n${reason}`);

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
			provider.emit("connection-error", [event, provider]);
		};
		websocket.onclose = (event) => {
			if (provider.ws !== websocket) {
				return;
			}
			provider.emit("connection-close", [event, provider]);
			provider.ws = null;
			provider.wsconnecting = false;
			provider.wsConnectStartTime = 0;
			const wasConnected = provider.wsconnected;
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
			} else {
				provider.wsUnsuccessfulReconnects++;
			}
			provider.emit("status", [
				{
					status: "disconnected",
					intent: provider.intent,
				},
			]);
			// Start with no reconnect timeout and increase timeout by
			// using exponential backoff starting with 100ms
			if (provider.canReconnect()) {
				const delay = math.min(
					math.pow(2, provider.wsUnsuccessfulReconnects) * 100,
					provider.maxBackoffTime,
				);
				provider._reconnectTimeout = setTimeout(() => {
					provider._reconnectTimeout = null;
					setupWS(provider);
				}, delay);
			} else if (!wasConnected) {
				provider.wsUnsuccessfulReconnects = provider.maxConnectionErrors;
			}
		};
		websocket.onopen = () => {
			if (provider.ws !== websocket) {
				return;
			}
			provider.wsLastMessageReceived = time.getUnixTime();
			provider.wsconnecting = false;
			provider.wsconnected = true;
			provider.wsConnectStartTime = 0;
			provider.wsUnsuccessfulReconnects = 0;
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
			// send because the WebSocket wasn't ready. The sync step 1/2
			// exchange above handles catch-up via state vectors, but
			// flushing the buffer ensures real-time updates that arrived
			// during the disconnect window are delivered promptly.
			if (provider._pendingMessages.length > 0) {
				for (const pending of provider._pendingMessages) {
					websocket.send(pending);
				}
				provider._pendingMessages = [];
			}
			// Re-subscribe to events after reconnection
			if (provider.eventSubscriptions.size > 0) {
				const eventTypes = Array.from(provider.eventSubscriptions);
				provider.sendEventSubscribe(eventTypes);
			}
			// Query subdoc state vectors for catch-up
			if (provider.onSubdocIndex) {
				provider.sendQuerySubdocs();
			}
			// broadcast local awareness state
			if (provider.awareness.getLocalState() !== null) {
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
	maxConnectionErrors?: number;
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
	stateVector: Uint8Array;
	lastSeen?: number;
}

export type SubdocIndex = Record<string, SubdocIndexEntry>;
export type SubdocIndexCallback = (serverIndex: SubdocIndex) => void;
export type SubdocQueryDocIdsProvider = () => string[];

export function normalizeSubdocIndex(rawIndex: unknown): SubdocIndex {
	const index: SubdocIndex = {};

	for (const [rawDocId, rawEntry] of readSubdocIndexEntries(rawIndex)) {
		if (typeof rawDocId !== "string" || rawDocId.length === 0) continue;
		const entry = normalizeSubdocIndexEntry(rawEntry);
		if (entry) {
			index[rawDocId] = entry;
		}
	}

	return index;
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
	const legacyStateVector = asUint8Array(rawEntry);
	if (legacyStateVector) {
		return { stateVector: legacyStateVector };
	}

	const stateVector =
		asUint8Array(readSubdocIndexField(rawEntry, "state_vector")) ??
		asUint8Array(readSubdocIndexField(rawEntry, "stateVector")) ??
		asUint8Array(readSubdocIndexField(rawEntry, "sv"));
	if (!stateVector) return null;

	const lastSeen = normalizeSubdocLastSeen(
		readSubdocIndexField(rawEntry, "last_seen") ??
			readSubdocIndexField(rawEntry, "lastSeen"),
	);
	return lastSeen === undefined
		? { stateVector }
		: { stateVector, lastSeen };
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
	maxConnectionErrors: number;
	eventSubscriptions: Set<string>;
	eventCallbacks: Map<string, EventCallback[]>;
	onSubdocIndex: SubdocIndexCallback | null;
	subdocIndexCallbacks: Set<SubdocIndexCallback>;
	lastSubdocIndex: SubdocIndex | null;
	getSubdocQueryDocIds: SubdocQueryDocIdsProvider | null;

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
			maxBackoffTime = 2500,
			disableBc = false,
			maxConnectionErrors = 3,
		}: YSweetProviderParams = {},
	) {
		super();
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
		this.messageHandlers = messageHandlers.slice();
		this._synced = false;
		this.ws = null;
		this.wsLastMessageReceived = 0;
		this.wsConnectStartTime = 0;
		this.shouldConnect = connect;
		this.maxConnectionErrors = maxConnectionErrors;
		this.eventSubscriptions = new Set();
		this.eventCallbacks = new Map();
		this.onSubdocIndex = null;
		this.subdocIndexCallbacks = new Set();
		this.lastSubdocIndex = null;
		this.getSubdocQueryDocIds = null;

		this._resyncInterval = 0;
		if (resyncInterval > 0) {
			this._resyncInterval = setInterval(() => {
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
		this._checkInterval = setInterval(() => {
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
		if (connect) {
			this.connect();
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
			setTimeout(() => f(this._synced), 0);
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
		return (
			!!this.url &&
			this.shouldConnect &&
			this.wsUnsuccessfulReconnects < this.maxConnectionErrors
		);
	}

	destroy() {
		if (this._resyncInterval !== 0) {
			clearInterval(this._resyncInterval);
		}
		clearInterval(this._checkInterval);
		if (this._reconnectTimeout !== null) {
			clearTimeout(this._reconnectTimeout);
			this._reconnectTimeout = null;
		}

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
		// broadcast local state
		const encoderState = encoding.createEncoder();
		encoding.writeVarUint(encoderState, messageSync);
		syncProtocol.writeSyncStep2(encoderState, this.doc);
		bc.publish(this.bcChannel, encoding.toUint8Array(encoderState), this);
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
		this.shouldConnect = false;
		this.wsconnected = false;
		this.wsconnecting = false;
		this.wsConnectStartTime = 0;
		this.synced = false;
		if (this._reconnectTimeout !== null) {
			clearTimeout(this._reconnectTimeout);
			this._reconnectTimeout = null;
		}
		this.disconnectBc();
		if (this.ws !== null) {
			this.ws.close();
			this.ws = null;
		}
	}


	connect() {
		const wasDisconnected = !this.shouldConnect;
		this.shouldConnect = true;
		if (this._reconnectTimeout !== null) {
			return;
		}
		if (!this.wsconnected && this.ws === null) {
			// User-initiated reconnects should start a fresh retry budget.
			// Without this, a previous exhausted reconnect cycle can leave the
			// provider permanently offline until the plugin is recreated.
			if (
				wasDisconnected ||
				this.wsUnsuccessfulReconnects >= this.maxConnectionErrors
			) {
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
	): { urlChanged: boolean; newUrl: string } {
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
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, messageQuerySubdocs);
			encoding.writeVarUint(encoder, queryDocIds.length);
			queryDocIds.forEach((docId) => {
				encoding.writeVarString(encoder, docId);
			});
			this.ws.send(encoding.toUint8Array(encoder));
			console.log(
				`[YSweetProvider] sent MSG_QUERY_SUBDOCS (${queryDocIds.length || "all"})`,
			);
		}
	}

	handleSubdocIndex(serverIndex: SubdocIndex) {
		this.lastSubdocIndex = serverIndex;
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
