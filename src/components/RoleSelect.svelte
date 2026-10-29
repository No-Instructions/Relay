<script lang="ts">
	import { Menu } from "obsidian";
	import type { Role } from "src/Relay";

	export let roles: { name: string }[];
	export let value: Role = "Member";
	export let excludeOwner = true;
	export let onChange: (role: Role) => void = () => {};

	let menuOpen = false;

	function rolePrioritySort(a: { name: string }, b: { name: string }) {
		const priority: Record<string, number> = { Owner: 0, Member: 1, Reader: 2 };
		return (priority[a.name] ?? 999) - (priority[b.name] ?? 999);
	}

	$: availableRoles = roles
		.filter((role) => !excludeOwner || role.name !== "Owner")
		.sort(rolePrioritySort);

	function selectRole(role: Role) {
		if (role === value) return;
		value = role;
		onChange(role);
	}

	// The menu closes on mousedown outside it, and the click that follows
	// still lands on whatever sits underneath, such as the user row this
	// select lives in. Drop that one click so dismissing the menu does nothing
	// else.
	function swallowDismissingClick(win: Window): () => void {
		let armed = false;
		const release = () => {
			win.removeEventListener("mousedown", onMouseDown, true);
			win.removeEventListener("mouseup", onMouseUp, true);
			win.removeEventListener("click", onClick, true);
		};
		const onMouseDown = (e: MouseEvent) => {
			const target = e.target as Node | null;
			if (!target?.instanceOf(Element) || !target.closest(".menu")) {
				armed = true;
			}
		};
		const onMouseUp = () => {
			// A press that ends in a drag produces no click to drop.
			if (armed) win.setTimeout(release, 0);
		};
		const onClick = (e: MouseEvent) => {
			if (!armed) return;
			e.stopPropagation();
			e.preventDefault();
			release();
		};
		win.addEventListener("mousedown", onMouseDown, true);
		win.addEventListener("mouseup", onMouseUp, true);
		win.addEventListener("click", onClick, true);
		return () => {
			if (!armed) release();
		};
	}

	function openMenu(e: MouseEvent) {
		if (menuOpen) return;
		const button = e.currentTarget as HTMLElement;
		const menu = new Menu().setUseNativeMenu(false);
		for (const role of availableRoles) {
			menu.addItem((item) => {
				item
					.setTitle(role.name)
					.setChecked(role.name === value)
					.onClick(() => selectRole(role.name as Role));
			});
		}
		const onHidden = swallowDismissingClick(button.win);
		menuOpen = true;
		menu.onHide(() => {
			menuOpen = false;
			onHidden();
		});
		const rect = button.getBoundingClientRect();
		menu.showAtPosition(
			{ x: rect.left, y: rect.bottom, width: rect.width, overlap: true, left: true },
			button.ownerDocument,
		);
	}
</script>

<button
	class="dropdown"
	aria-haspopup="menu"
	aria-expanded={menuOpen}
	on:click|stopPropagation={openMenu}
	on:keydown|stopPropagation
>
	{value}
</button>
