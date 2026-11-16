import {
	resolveSettingsTarget,
	sameSettingsTarget,
	type SettingsRecords,
	type SettingsTarget,
} from "./settingsTarget";

/** A settings page: the records it shows and the component that shows them. */
export interface SettingsPage<Component> extends SettingsTarget {
	component: Component;
}

export interface PageRules<Component> {
	records: SettingsRecords;
	/** The component that shows a resolved target; `requested` is the one asked for. */
	componentFor(target: SettingsTarget, requested: Component): Component;
}

export interface SettingsStack<Component> {
	history: SettingsPage<Component>[];
	current: SettingsPage<Component>;
}

/** Whether two pages show the same thing. */
export function samePage<C>(a: SettingsPage<C>, b: SettingsPage<C>): boolean {
	return a.component === b.component && sameSettingsTarget(a, b);
}

/**
 * Resolve a page against the live records. The same object comes back while
 * its records stand, so a retained page keeps its identity; a page whose
 * records moved becomes a fresh page for the resolved target; a page whose
 * records are gone resolves to nothing.
 */
export function resolvePage<C>(
	page: SettingsPage<C>,
	rules: PageRules<C>,
): SettingsPage<C> | undefined {
	const { relays, remoteFolders, sharedFolders } = rules.records;
	const target = resolveSettingsTarget(page, relays, remoteFolders, sharedFolders);
	if (!target) return undefined;
	const component = rules.componentFor(target, page.component);
	if (component === page.component && sameSettingsTarget(target, page)) return page;
	return { ...target, component };
}

/**
 * Resolve every page, drop the ones whose records are gone, and collapse
 * neighbours that would show the same page.
 */
export function resolvePages<C>(pages: SettingsPage<C>[], rules: PageRules<C>): SettingsPage<C>[] {
	const resolved: SettingsPage<C>[] = [];
	for (const page of pages) {
		const live = resolvePage(page, rules);
		if (!live) continue;
		const previous = resolved[resolved.length - 1];
		if (previous && samePage(previous, live)) continue;
		resolved.push(live);
	}
	return resolved;
}

/**
 * Open a page. The request is resolved first so that it compares with the
 * stacked pages by their live records, whatever the requester knew. Opening
 * the page already on screen changes nothing. With `reuseAncestors` an open
 * ancestor is returned to and the pages above it are dropped; otherwise the
 * current page is pushed. A request whose records are gone is opened as asked
 * and left to the next resolution.
 */
export function openPage<C>(
	stack: SettingsStack<C>,
	request: SettingsPage<C>,
	rules: PageRules<C>,
	reuseAncestors: boolean,
): SettingsStack<C> {
	const next = resolvePage(request, rules) ?? {
		...request,
		component: rules.componentFor(request, request.component),
	};
	if (samePage(stack.current, next)) return stack;
	const parents = resolvePages(stack.history, rules);
	const ancestor = reuseAncestors ? parents.findIndex((page) => samePage(page, next)) : -1;
	if (ancestor >= 0) {
		return { history: parents.slice(0, ancestor), current: parents[ancestor] };
	}
	const current = resolvePage(stack.current, rules);
	return { history: current ? [...parents, current] : parents, current: next };
}

/**
 * Go back one page. Parents whose records are gone, or that would show the
 * page already on screen, are skipped so that one step always moves
 * somewhere; an exhausted stack lands on `root`.
 */
export function closePage<C>(
	stack: SettingsStack<C>,
	rules: PageRules<C>,
	root: SettingsPage<C>,
): SettingsStack<C> {
	const parents = resolvePages(stack.history, rules);
	let parent: SettingsPage<C> | undefined;
	while ((parent = parents.pop())) {
		if (!samePage(parent, stack.current)) break;
	}
	return { history: parents, current: parent ?? root };
}
