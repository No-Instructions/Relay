<script lang="ts">
	export let object: object;
</script>

<div class="object-state-display">
	<pre>{Object.keys(object).join("\n")}
        </pre>
</div>

<style>
	.object-state-display {
		padding: 10px;
		margin-top: 10px;
		font-family: monospace;
	}
	pre {
		white-space: pre-wrap;
		word-wrap: break-word;
	}
</style>
