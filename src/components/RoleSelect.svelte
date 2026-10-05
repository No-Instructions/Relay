<script lang="ts">
	import type { Role } from "src/Relay";

	export let roles: { name: string }[];
	export let value: Role = "Member";
	export let excludeOwner = true;
	export let onChange: (role: Role) => void = () => {};

	function rolePrioritySort(a: { name: string }, b: { name: string }) {
		const priority: Record<string, number> = { Owner: 0, Member: 1, Reader: 2 };
		return (priority[a.name] ?? 999) - (priority[b.name] ?? 999);
	}

	$: availableRoles = roles
		.filter((role) => !excludeOwner || role.name !== "Owner")
		.sort(rolePrioritySort);

	function handleChange(e: Event) {
		const role = (e.target as HTMLSelectElement).value as Role;
		value = role;
		onChange(role);
	}
</script>

<select
	class="dropdown"
	{value}
	on:change={handleChange}
	on:click|stopPropagation
	on:keydown|stopPropagation
>
	{#each availableRoles as role}
		<option value={role.name}>{role.name}</option>
	{/each}
</select>
