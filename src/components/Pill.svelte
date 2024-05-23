<script lang="ts">
	import type { ConnectionStatus } from "src/HasProvider";

	export let status: ConnectionStatus = "disconnected";
</script>

<div class="system3-pill system3-{status}">
	<span>live</span>
</div>

<style>
	.system3-pill {
		border: 1px solid transparent;
		margin: 0px 4px 0px 0px;
		display: flex;
		align-self: center;
		margin-left: auto;
	}

	.system3-pill > span {
		color: var(--text-on-accent);
		border-radius: var(--radius-s);
		padding: 0px 5px 0px 5px;
	}

	.system3-pill.system3-connected > span {
		background-color: var(--color-accent);
	}

	.system3-pill.system3-disconnected > span {
		background-color: var(--color-base-40);
	}
</style>
