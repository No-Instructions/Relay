"use strict";

/**
 * Tests for the userDisconnectedIntent flag pattern.
 *
 * This flag tracks whether a user has EXPLICITLY disconnected a document
 * via the UI toggle, as opposed to the document being disconnected due to:
 * - View lifecycle (release() when navigating away)
 * - Network issues
 * - Other system-initiated disconnections
 *
 * The flag should:
 * - Default to false (documents should connect by default)
 * - Only be set to true via explicit user action (toggleConnection)
 * - NOT be affected by disconnect() calls
 * - Be used by LiveViews.getViews() to determine shouldConnect for new LiveView instances
 *
 * Bug context: When a user disconnects a note and navigates away/back,
 * the note was auto-reconnecting because getViews() created new LiveView
 * instances with shouldConnect=true by default, ignoring user intent.
 *
 * This test file tests the FLAG BEHAVIOR PATTERN in isolation, without
 * requiring full Obsidian dependencies. The actual Document/Canvas classes
 * follow this same pattern.
 *
 * For E2E verification, use the live-debug skill:
 *   python .claude/scripts/obsidian_debug.py --vault <name> relay file-status "test.md"
 */

/**
 * Minimal class that mimics the userDisconnectedIntent pattern
 * implemented in Document and Canvas.
 */
class MockDocumentWithUserIntent {
	/**
	 * Tracks whether the user has explicitly disconnected this document.
	 * - Default: false (connect by default)
	 * - Set to true: only via explicit user action (toggleConnection)
	 * - NOT modified by: disconnect(), release(), network issues
	 */
	userDisconnectedIntent: boolean = false;

	// Simulates provider's shouldConnect (affected by disconnect())
	private _providerShouldConnect: boolean = true;

	/**
	 * Simulates the disconnect() method from HasProvider.
	 * This sets provider.shouldConnect = false but should NOT
	 * affect userDisconnectedIntent.
	 */
	disconnect(): void {
		this._providerShouldConnect = false;
		// NOTE: userDisconnectedIntent is NOT modified here
	}

	/**
	 * Simulates the connect() method from HasProvider.
	 */
	connect(): void {
		this._providerShouldConnect = true;
	}

	/**
	 * Simulates intent getter (derived from provider.shouldConnect).
	 */
	get intent(): "connected" | "disconnected" {
		return this._providerShouldConnect ? "connected" : "disconnected";
	}
}

/**
 * Simulates LiveView behavior with the userDisconnectedIntent fix.
 */
class MockLiveView {
	shouldConnect: boolean;
	document: MockDocumentWithUserIntent;

	constructor(document: MockDocumentWithUserIntent, shouldConnect = true) {
		this.document = document;
		this.shouldConnect = shouldConnect;
	}

	/**
	 * Simulates the toggleConnection() method with the fix applied.
	 */
	toggleConnection(): void {
		this.shouldConnect = !this.shouldConnect;
		// THE FIX: Track explicit user disconnect intent
		this.document.userDisconnectedIntent = !this.shouldConnect;
		if (this.shouldConnect) {
			this.document.connect();
		} else {
			this.document.disconnect();
		}
	}

	/**
	 * Simulates release() when navigating away.
	 */
	release(): void {
		this.document.disconnect();
		// NOTE: userDisconnectedIntent is NOT modified here
	}
}

/**
 * Simulates getViews() creating a new LiveView with the fix applied.
 */
function createLiveViewFromDocument(
	doc: MockDocumentWithUserIntent,
): MockLiveView {
	// THE FIX: Use userDisconnectedIntent to determine shouldConnect
	const shouldConnect = !doc.userDisconnectedIntent;
	return new MockLiveView(doc, shouldConnect);
}

describe("userDisconnectedIntent flag pattern", () => {
	describe("Document flag behavior", () => {
		let doc: MockDocumentWithUserIntent;

		beforeEach(() => {
			doc = new MockDocumentWithUserIntent();
		});

		it("should default userDisconnectedIntent to false", () => {
			expect(doc.userDisconnectedIntent).toBe(false);
		});

		it("should preserve userDisconnectedIntent=true after disconnect()", () => {
			doc.userDisconnectedIntent = true;
			doc.disconnect();
			expect(doc.userDisconnectedIntent).toBe(true);
		});

		it("should preserve userDisconnectedIntent=false after disconnect()", () => {
			expect(doc.userDisconnectedIntent).toBe(false);
			doc.disconnect();
			expect(doc.userDisconnectedIntent).toBe(false);
		});
	});

	describe("LiveView toggleConnection behavior", () => {
		let doc: MockDocumentWithUserIntent;
		let view: MockLiveView;

		beforeEach(() => {
			doc = new MockDocumentWithUserIntent();
			view = new MockLiveView(doc);
		});

		it("should set userDisconnectedIntent=true when user disconnects", () => {
			expect(doc.userDisconnectedIntent).toBe(false);
			view.toggleConnection(); // User clicks to disconnect
			expect(doc.userDisconnectedIntent).toBe(true);
			expect(view.shouldConnect).toBe(false);
		});

		it("should set userDisconnectedIntent=false when user reconnects", () => {
			view.toggleConnection(); // Disconnect
			expect(doc.userDisconnectedIntent).toBe(true);

			view.toggleConnection(); // Reconnect
			expect(doc.userDisconnectedIntent).toBe(false);
			expect(view.shouldConnect).toBe(true);
		});
	});

	describe("Navigation scenario (the bug fix)", () => {
		it("should preserve disconnect intent across navigation", () => {
			// Setup: Document exists, user opens it
			const doc = new MockDocumentWithUserIntent();
			let view = new MockLiveView(doc);

			// User explicitly disconnects
			view.toggleConnection();
			expect(doc.userDisconnectedIntent).toBe(true);
			expect(view.shouldConnect).toBe(false);

			// User navigates away (release is called)
			view.release();

			// User navigates back (new LiveView is created)
			// THIS IS THE BUG FIX: getViews() now uses userDisconnectedIntent
			view = createLiveViewFromDocument(doc);

			// New view should respect user's disconnect intent
			expect(view.shouldConnect).toBe(false);
			expect(doc.userDisconnectedIntent).toBe(true);
		});

		it("should auto-connect when user never explicitly disconnected", () => {
			// Setup: Document exists, user opens it
			const doc = new MockDocumentWithUserIntent();
			let view = new MockLiveView(doc);
			expect(view.shouldConnect).toBe(true);

			// User navigates away without disconnecting
			view.release();

			// User navigates back
			view = createLiveViewFromDocument(doc);

			// New view should auto-connect (default behavior)
			expect(view.shouldConnect).toBe(true);
			expect(doc.userDisconnectedIntent).toBe(false);
		});

		it("should auto-connect after user explicitly reconnects", () => {
			const doc = new MockDocumentWithUserIntent();
			let view = new MockLiveView(doc);

			// User disconnects then reconnects
			view.toggleConnection(); // Disconnect
			view.toggleConnection(); // Reconnect
			expect(doc.userDisconnectedIntent).toBe(false);

			// User navigates away
			view.release();

			// User navigates back
			view = createLiveViewFromDocument(doc);

			// New view should auto-connect
			expect(view.shouldConnect).toBe(true);
		});
	});
});

/**
 * Integration behavior documentation (verified manually via E2E):
 *
 * When user clicks disconnect toggle in LiveView:
 * 1. LiveView.toggleConnection() is called
 * 2. Sets this.shouldConnect = false
 * 3. Sets this.document.userDisconnectedIntent = true
 * 4. Calls this.document.disconnect()
 *
 * When user navigates away:
 * 1. LiveView.release() is called
 * 2. Calls this.document.disconnect()
 * 3. userDisconnectedIntent is NOT changed (stays true if user disconnected)
 *
 * When user navigates back:
 * 1. LiveViewManager.getViews() is called
 * 2. Creates new LiveView with shouldConnect = !doc.userDisconnectedIntent
 * 3. If user had disconnected, new LiveView has shouldConnect = false
 * 4. Document stays disconnected as user intended
 *
 * When user clicks connect toggle:
 * 1. LiveView.toggleConnection() is called
 * 2. Sets this.shouldConnect = true
 * 3. Sets this.document.userDisconnectedIntent = false
 * 4. Calls this.document.connect()
 *
 * E2E verification command:
 *   python .claude/scripts/obsidian_debug.py --vault <name> relay file-status "test.md"
 */
