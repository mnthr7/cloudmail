<script lang="ts">
	// CloudMail mark: an ink tile with an amber "C" with a cream dash running out of its mouth.
	// The same glyph as the favicon, so it reads at 16px and in the header.
	let {
		size = 30,
		class: className = ''
	}: {
		size?: number;
		class?: string;
	} = $props();
</script>

<svg
	class={className}
	width={size}
	height={size}
	viewBox="0 0 32 32"
	xmlns="http://www.w3.org/2000/svg"
	role="img"
	aria-label="CloudMail"
>
	<rect width="32" height="32" rx="7" fill="#1D1914"/>
	<path d="M20.4 21.4A7.6 7.6 0 1 1 20.4 10.6" fill="none" stroke="#E2A043" stroke-width="3.4" stroke-linecap="round"/>
	<path d="M16 16h9.4" stroke="#F3EBDD" stroke-width="3.4" stroke-linecap="round"/>
</svg>
