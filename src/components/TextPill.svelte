<script lang="ts">
	export let text: string;
	export let label: string;
	export let reason: string | undefined = undefined;
	/** Names the pill's class, so each decoration finds only its own pills. */
	export let kind = "filepill";
	/**
	 * Opens the pill's explanation. A pill with one reads as a button, its
	 * tooltip says so, and activating it does not open the file underneath.
	 */
	export let onClick: (() => void) | undefined = undefined;

	function activate(event: Event) {
		if (!onClick) return;
		event.preventDefault();
		event.stopPropagation();
		onClick();
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === "Enter" || event.key === " ") activate(event);
	}
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
<div
	class="nav-file-tag system3-{kind}"
	class:system3-pill-button={!!onClick}
	aria-label={onClick ? `${label} · Click for details` : label}
	data-reason={reason}
	role={onClick ? "button" : undefined}
	tabindex={onClick ? 0 : undefined}
	on:click={activate}
	on:keydown={keydown}
>
	<span>{text}</span>
</div>

<style>
	.nav-file-tag {
		text-wrap: nowrap;
	}
</style>
