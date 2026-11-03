export type EditorCommand = {
	label: string;
	command: string;
	value?: string;
};

export const EDITOR_COMMANDS: EditorCommand[] = [
	{ label: 'Bold', command: 'bold' },
	{ label: 'Italic', command: 'italic' },
	{ label: 'Underline', command: 'underline' },
	{ label: 'Strikethrough', command: 'strikeThrough' },
	{ label: 'Link', command: 'createLink' },
	{ label: 'Bulleted list', command: 'insertUnorderedList' },
	{ label: 'Numbered list', command: 'insertOrderedList' },
	{ label: 'Quote', command: 'formatBlock', value: 'blockquote' },
	{ label: 'Align left', command: 'justifyLeft' },
	{ label: 'Align center', command: 'justifyCenter' },
	{ label: 'Align right', command: 'justifyRight' },
	{ label: 'Indent', command: 'indent' },
	{ label: 'Outdent', command: 'outdent' },
	{ label: 'Sans', command: 'fontName', value: 'sans-serif' },
	{ label: 'Serif', command: 'fontName', value: 'serif' },
	{ label: 'Mono', command: 'fontName', value: 'monospace' },
	{ label: 'Small', command: 'fontSize', value: '2' },
	{ label: 'Normal', command: 'fontSize', value: '3' },
	{ label: 'Large', command: 'fontSize', value: '5' },
	{ label: 'Huge', command: 'fontSize', value: '6' },
	{ label: 'Black', command: 'foreColor', value: '#111111' },
	{ label: 'Red', command: 'foreColor', value: '#e03e3e' },
	{ label: 'Orange', command: 'foreColor', value: '#d9730d' },
	{ label: 'Green', command: 'foreColor', value: '#0b6e4f' },
	{ label: 'Blue', command: 'foreColor', value: '#0b6bcb' },
	{ label: 'Violet', command: 'foreColor', value: '#6940a5' },
	{ label: 'Clear color', command: 'foreColor', value: 'inherit' }
];
