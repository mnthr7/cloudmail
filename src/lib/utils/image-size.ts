/** Gmail's "Small" is a fixed 200px-wide image. */
export const SMALL_IMAGE_WIDTH = 200;
export const MIN_IMAGE_WIDTH = 48;

export type ImageSizePreset = 'small' | 'best' | 'original';

/**
 * Pixel width for a preset. Best fit is the compose column. Original is the
 * file's own width. Small never scales an image up past its natural size.
 */
export function widthForPreset(
	preset: ImageSizePreset,
	naturalWidth: number,
	contentWidth: number
): number {
	const column = Math.max(MIN_IMAGE_WIDTH, Math.round(contentWidth) || SMALL_IMAGE_WIDTH);
	const natural = Math.max(0, Math.round(naturalWidth));
	if (preset === 'small') return Math.min(SMALL_IMAGE_WIDTH, natural || SMALL_IMAGE_WIDTH);
	if (preset === 'best') return column;
	return natural || column;
}

/** Drag stays inside the column so the image cannot be pulled wider than the message. */
export function clampDragWidth(width: number, contentWidth: number): number {
	const column = Math.max(MIN_IMAGE_WIDTH, Math.round(contentWidth) || SMALL_IMAGE_WIDTH);
	return Math.min(column, Math.max(MIN_IMAGE_WIDTH, Math.round(width)));
}
