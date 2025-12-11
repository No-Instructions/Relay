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

export const messageSync = 0;
export const messageQueryAwareness = 3;
export const messageAwareness = 1;
export const messageAuth = 2;
export const messageEvent = 4;
export const messageEventSubscribe = 5;
export const messageEventUnsubscribe = 6;

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
		console.error('Failed to decode event message:', error);
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
		provider.synced = false;

		websocket.onmessage = (event) => {
			provider.wsLastMessageReceived = time.getUnixTime();
			const encoder = readMessage(provider, new Uint8Array(event.data), true);
			if (encoding.length(encoder) > 1) {
				websocket.send(encoding.toUint8Array(encoder));
			}
		};
		websocket.onerror = (event) => {
			provider.emit("connection-error", [event, provider]);
		};
		websocket.onclose = (event) => {
			provider.emit("connection-close", [event, provider]);
			provider.ws = null;
			provider.wsconnecting = false;
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
				provider.emit("status", [
					{
						status: "disconnected",
						intent: provider.intent,
					},
				]);
			} else {
				provider.wsUnsuccessfulReconnects++;
			}
			// Start with no reconnect timeout and increase timeout by
			// using exponential backoff starting with 100ms
			if (provider.canReconnect()) {
				setTimeout(
					setupWS,
					math.min(
						math.pow(2, provider.wsUnsuccessfulReconnects) * 100,
						provider.maxBackoffTime,
					),
					provider,
				);
			}
		};
		websocket.onopen = () => {
			provider.wsLastMessageReceived = time.getUnixTime();
			provider.wsconnecting = false;
			provider.wsconnected = true;
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
			// Re-subscribe to events after reconnection
			if (provider.eventSubscriptions.size > 0) {
				const eventTypes = Array.from(provider.eventSubscriptions);
				provider.sendEventSubscribe(eventTypes);
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
	_synced: boolean;
	ws: WebSocket | null;
	wsLastMessageReceived: number;
	shouldConnect: boolean;
	_resyncInterval: ReturnType<typeof setInterval> | number; // TODO: is setting this to 0 used as null?
	_bcSubscriber: Function;
	_updateHandler: (
		arg0: Uint8Array,
		arg1: any,
		arg2: Y.Doc,
		arg3: Y.Transaction,
	) => void;
	_awarenessUpdateHandler: Function;
	_unloadHandler: Function;
	_checkInterval: ReturnType<typeof setInterval> | number;
	maxConnectionErrors: number;
	eventSubscriptions: Set<string>;
	eventCallbacks: Map<string, EventCallback[]>;

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
		this.wsconnecting = false;
		this.bcconnected = false;
		this.disableBc = disableBc;
		this.wsUnsuccessfulReconnects = 0;
		this.messageHandlers = messageHandlers.slice();
		this._synced = false;
		this.ws = null;
		this.wsLastMessageReceived = 0;
		this.shouldConnect = connect;
		this.maxConnectionErrors = maxConnectionErrors;
		this.eventSubscriptions = new Set();
		this.eventCallbacks = new Map();

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
				const encoder = encoding.createEncoder();
				encoding.writeVarUint(encoder, messageSync);
				syncProtocol.writeUpdate(encoder, update);
				broadcastMessage(this, encoding.toUint8Array(encoder));
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
		}, messageReconnectTimeout / 10);
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
		this.disconnectBc();
		if (this.ws !== null) {
			this.ws.close();
			this.ws = null;
		}
	}


	connect() {
		this.shouldConnect = true;
		if (!this.wsconnected && this.ws === null) {
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

	/**
	 * Subscribe to server events
	 * @param eventTypes - Array of event types to subscribe to (e.g. ['document.updated'])
	 * @param callback - Callback function to execute when events are received
	 */
	subscribeToEvents(eventTypes: string[], callback: EventCallback) {
		// Add to subscription set
		eventTypes.forEach(type => {
			this.eventSubscriptions.add(type);
			
			// Register callback
			if (!this.eventCallbacks.has(type)) {
				this.eventCallbacks.set(type, []);
			}
			this.eventCallbacks.get(type)!.push(callback);
		});
		
		// Send subscription message if connected
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.sendEventSubscribe(eventTypes);
		}
	}
	
	/**
	 * Unsubscribe from server events
	 * @param eventTypes - Array of event types to unsubscribe from
	 * @param callback - Specific callback to remove (optional, removes all if not provided)
	 */
	unsubscribeFromEvents(eventTypes: string[], callback?: EventCallback) {
		eventTypes.forEach(type => {
			if (callback && this.eventCallbacks.has(type)) {
				const callbacks = this.eventCallbacks.get(type)!;
				const index = callbacks.indexOf(callback);
				if (index > -1) {
					callbacks.splice(index, 1);
				}
				// Remove type from subscriptions if no callbacks left
				if (callbacks.length === 0) {
					this.eventSubscriptions.delete(type);
					this.eventCallbacks.delete(type);
				}
			} else {
				// Remove all callbacks for this type
				this.eventSubscriptions.delete(type);
				this.eventCallbacks.delete(type);
			}
		});
		
		// Send unsubscribe message if connected
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.sendEventUnsubscribe(eventTypes);
		}
	}
	
	/**
	 * Send event subscription message to server
	 * @param eventTypes - Array of event types to subscribe to
	 */
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
	
	/**
	 * Send event unsubscription message to server
	 * @param eventTypes - Array of event types to unsubscribe from
	 */
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
	
	/**
	 * Process incoming event message
	 * @param eventMessage - Decoded event message from server
	 */
	processEvent(eventMessage: EventMessage) {
		console.log('Received event:', eventMessage);
		
		// Emit as a provider event
		this.emit('event', [eventMessage]);
		
		// Trigger callbacks for this event type
		const callbacks = this.eventCallbacks.get(eventMessage.event_type) || [];
		callbacks.forEach(callback => {
			try {
				callback(eventMessage);
			} catch (error) {
				console.error('Event callback error:', error);
			}
		});
	}

}
