<script lang="ts">
	export let text: string;
	export let label: string;
	export let reason: string | undefined = undefined;
	/** Names the pill's class, so each decoration finds only its own pills. */
	export let kind = "filepill";
</script>

<div class="nav-file-tag system3-{kind}" aria-label={label} data-reason={reason}>
	<span>{text}</span>
</div>

<style>
	.nav-file-tag {
		text-wrap: nowrap;
	}
</style>
