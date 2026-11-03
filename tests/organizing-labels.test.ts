import { describe, expect, test } from 'bun:test';
import { labelEditError } from '../src/lib/organizing/labels';

const tree = [
	{ id: 'work', parentId: null, name: 'Work' },
	{ id: 'clients', parentId: 'work', name: 'Clients' }
];

describe('labelEditError', () => {
	test('sibling names collide and root names collide', () => {
		expect(labelEditError(tree, { id: 'new', parentId: 'work', name: 'clients' })).toBe('duplicate');
		expect(labelEditError(tree, { id: 'new', parentId: null, name: 'Work' })).toBe('duplicate');
		expect(labelEditError(tree, { id: 'work', parentId: null, name: 'Work' })).toBe(null);
	});

	test('a label cannot move under its own descendant', () => {
		expect(labelEditError(tree, { id: 'work', parentId: 'clients', name: 'Work' })).toBe('cycle');
	});

	test('the sixth level is rejected', () => {
		const deep = [
			{ id: 'a', parentId: null, name: 'A' },
			{ id: 'b', parentId: 'a', name: 'B' },
			{ id: 'c', parentId: 'b', name: 'C' },
			{ id: 'd', parentId: 'c', name: 'D' },
			{ id: 'e', parentId: 'd', name: 'E' }
		];
		expect(labelEditError(deep, { id: 'f', parentId: 'e', name: 'F' })).toBe('depth');
	});

	test('moving a label rejects when a descendant would pass level five', () => {
		const labels = [
			{ id: 'a', parentId: null, name: 'A' },
			{ id: 'b', parentId: 'a', name: 'B' },
			{ id: 'c', parentId: 'b', name: 'C' },
			{ id: 'd', parentId: 'c', name: 'D' },
			{ id: 'e', parentId: 'd', name: 'E' },
			{ id: 'x', parentId: null, name: 'X' },
			{ id: 'y', parentId: 'x', name: 'Y' }
		];
		expect(labelEditError(labels, { id: 'b', parentId: 'y', name: 'B' })).toBe('depth');
	});

	test('moving a label allows when the subtree stays within five levels', () => {
		const labels = [
			{ id: 'a', parentId: null, name: 'A' },
			{ id: 'b', parentId: 'a', name: 'B' },
			{ id: 'c', parentId: 'b', name: 'C' },
			{ id: 'd', parentId: 'c', name: 'D' },
			{ id: 'e', parentId: 'd', name: 'E' },
			{ id: 'x', parentId: null, name: 'X' },
			{ id: 'y', parentId: 'x', name: 'Y' }
		];
		expect(labelEditError(labels, { id: 'd', parentId: 'y', name: 'D' })).toBe(null);
	});
});
