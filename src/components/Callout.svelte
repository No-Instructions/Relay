<script lang="ts">
	export let title: string;
</script>

<div
	data-callout-metadata=""
	data-callout-fold=""
	data-callout="callout"
	class="callout"
	dir="auto"
>
	<div class="callout-title" dir="auto">
		<div class="callout-icon" dir="auto">
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="24"
				height="24"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="svg-icon lucide-pencil"
				><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"
				></path><path d="m15 5 4 4"></path></svg
			>
		</div>
		<div class="callout-title-inner" dir="auto">{title}</div>
	</div>

	<div class="callout-content" dir="auto">
		<p dir="auto">
			<slot></slot>
		</p>
	</div>
</div>

<style>
.callout {
  mix-blend-mode: normal !important;
}
</style>
