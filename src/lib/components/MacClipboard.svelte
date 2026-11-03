<script lang="ts">
	/**
	 * On a Mac, Control-C / Control-V are not the system copy and paste keys
	 * (Command is). The composer still needs them: Control-V never fires a paste
	 * event, so nothing shows up. Command-V keeps the normal paste path.
	 */
	import {
		applyPaste,
		armMacPaste,
		capturePasteSlot,
		deleteSelection,
		isMacPlatform,
		readSystemClipboard,
		selectedPlainText
	} from '$lib/utils/editor-paste';

	function onKeydown(event: KeyboardEvent) {
		if (!isMacPlatform()) return;
		if (event.defaultPrevented || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
			return;
		}

		const key = event.key.toLowerCase();
		if (key !== 'c' && key !== 'v' && key !== 'x') return;

		if (key === 'c' || key === 'x') {
			const text = selectedPlainText(event.target);
			if (!text) return;
			event.preventDefault();
			const target = event.target;
			void navigator.clipboard.writeText(text).then(() => {
				if (key === 'x') deleteSelection(target);
			});
			return;
		}

		const slot = capturePasteSlot(event.target);
		if (!slot) return;
		armMacPaste();
		event.preventDefault();
		void readSystemClipboard().then(({ text, images }) => {
			if (!text && images.length === 0) return;
			applyPaste(slot, text, images);
		});
	}
</script>

<svelte:window onkeydowncapture={onKeydown} />
