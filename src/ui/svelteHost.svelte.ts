/* global $state -- rune the Svelte compiler resolves in this module */
import { mount, unmount, type Component } from "svelte";

/** A Svelte component mounted from TypeScript, with props the host can update. */
export interface MountedComponent<
	Props extends Record<string, unknown> = Record<string, unknown>,
> {
	/** Assign new prop values; the component re-renders on the next tick. */
	set(patch: Partial<Props>): void;
	/** Remove the component from the DOM. */
	destroy(): void;
}

/**
 * Mount a component into `target` with reactive props. The props object is
 * `$state`, so later `set` calls flow into the component like prop updates.
 */
export function mountComponent<Props extends Record<string, unknown>>(
	component: Component<Record<string, unknown>>,
	options: { target: Element; anchor?: Node; props: Props },
): MountedComponent<Props> {
	const props = $state(options.props);
	const instance = mount(component, {
		target: options.target,
		anchor: options.anchor,
		props,
	});
	return {
		set(patch) {
			Object.assign(props, patch);
		},
		destroy() {
			void unmount(instance);
		},
	};
}
