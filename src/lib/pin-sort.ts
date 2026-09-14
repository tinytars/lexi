export function sortPinnedFirst<T>(
	items: T[],
	getPinned: (item: T) => boolean | undefined = (item) => (item as { pinned?: boolean }).pinned,
): T[] {
	const pinned = items.filter((item) => getPinned(item) === true);
	const rest = items.filter((item) => getPinned(item) !== true);
	return [...pinned, ...rest];
}
