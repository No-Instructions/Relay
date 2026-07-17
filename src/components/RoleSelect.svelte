<script lang="ts">
	import type { Role } from "src/Relay";
	import type { RelayManager } from "src/RelayManager";
	import { derived } from "svelte/store";
	import { flags } from "src/flagManager";

	export let relayManager: RelayManager;
	export let value: Role = "Member";
	export let excludeOwner = true;
	export let onChange: (role: Role) => void = () => {};

	const readOnlyPermissionsEnabled = flags().enableReadOnlyPermissions;

	function rolePrioritySort(a: { name: Role }, b: { name: Role }) {
		const priority: Record<Role, number> = { Owner: 0, Member: 1, Reader: 2 };
		return (priority[a.name] ?? 999) - (priority[b.name] ?? 999);
	}

	// Roles come from the server's roles collection so new roles surface
	// without a client release.
	const availableRoles = derived([relayManager.roles], ([$roles]) => {
		return $roles
			.values()
			.filter((role) => !excludeOwner || role.name !== "Owner")
			.filter(
				(role) => readOnlyPermissionsEnabled || role.name !== "Reader",
			)
			.sort(rolePrioritySort);
	});

	function handleChange(e: Event) {
		const role = (e.target as HTMLSelectElement).value as Role;
		value = role;
		onChange(role);
	}
</script>

<select class="dropdown" {value} on:change={handleChange} on:click|stopPropagation>
	{#each $availableRoles as role}
		<option value={role.name}>{role.name}</option>
	{/each}
</select>
