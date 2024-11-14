<script>
	import { MessageSquareHeart } from "lucide-svelte";
	import Discord from "./Discord.svelte";
	let isOpen = false;

	function clickOutside(node) {
		const handleClick = (event) => {
			// Check if the click target is NOT the button and NOT inside the dropdown
			const menuButton = document.querySelector(".menu-button");
			if (
				!node.contains(event.target) &&
				event.target !== menuButton &&
				!menuButton?.contains(event.target)
			) {
				isOpen = false;
			}
		};

		// Use setTimeout to add the listener on the next tick
		setTimeout(() => {
			document.addEventListener("click", handleClick);
		}, 0);

		return {
			destroy() {
				document.removeEventListener("click", handleClick);
			},
		};
	}

	function toggleMenu(event) {
		event.stopPropagation();
		isOpen = !isOpen;
	}
</script>

<div class="menu-container">
	<button on:click|stopPropagation={toggleMenu} class="menu-button">
		<MessageSquareHeart size={"20px"} />
	</button>

	{#if isOpen}
		<div class="menu-dropdown" use:clickOutside>
			<div class="arrow" />
			<div class="menu-content">
				<span style="text-align: center; display: flex">
					<a
						href="https://discord.system3.md"
						target="_blank"
						rel="noopener noreferrer"
						class="menu-item"
					>
						<Discord size={20} />
						<span>Join the community</span>
					</a>
				</span>
			</div>
		</div>
	{/if}
</div>

<style>
	.menu-container {
		display: inline-block;
		position: relative;
	}

	.menu-button {
		box-shadow: none;
		padding: 8px;
		border: none;
		background: transparent;
		color: var(--text-muted);
	}

	.menu-button:hover {
		color: var(--icon-color-hover);
	}
	.menu-button:focus {
		color: var(--icon-color-focus);
	}

	.menu-dropdown {
		position: absolute;
		right: 0;
		margin-top: 8px;
		width: 224px;
		background: var(--color-base-10);
		border-radius: 6px;
		box-shadow:
			0 4px 6px -1px rgba(0, 0, 0, 0.1),
			0 2px 4px -1px rgba(0, 0, 0, 0.06);
		border: 1px solid rgba(0, 0, 0, 0.1);
	}

	.arrow {
		position: absolute;
		top: -5px;
		right: 12px;
		width: 10px;
		height: 10px;
		background: var(--color-base-10);
		border-left: 1px solid rgba(0, 0, 0, 0.1);
		border-top: 1px solid rgba(0, 0, 0, 0.1);
		transform: rotate(45deg);
	}

	.menu-content {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 8px;
	}

	.menu-item {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 12px;
		padding: 8px;
		border-radius: 4px;
		text-decoration: none;
		color: var(--text-muted);
		transition: background-color 0.2s;
		font-size: 14px;
	}

	.menu-item:hover {
		background-color: var(--background-modifier-hover);
	}

	.menu-item:focus {
		background-color: var(--background-modifier-hover);
	}
</style>
