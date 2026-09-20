/**
 * Settings and popout windows each have their own document, timers and
 * viewport. A component's module scope belongs to the window the plugin
 * loaded in, so reaching `document`, `setTimeout` or `window.innerWidth`
 * directly reaches that window wherever the component was actually mounted:
 * listeners bind to a document the user is not clicking in, geometry is
 * measured against a viewport the element is not inside, and nodes attach to
 * a body in another window.
 *
 * Components take those globals from an element they own instead. The module
 * globals remain the fallback for an element that is not mounted yet, which
 * is the one case where no better answer exists.
 */

export function ownerDoc(el: Node | null | undefined): Document {
	return el?.ownerDocument ?? document;
}

export function ownerWin(el: Node | null | undefined): Window {
	return ownerDoc(el).defaultView ?? window;
}
