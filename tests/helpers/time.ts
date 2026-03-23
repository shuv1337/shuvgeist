export function withFixedDate(isoDate: string): void {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(isoDate));
}

export function restoreRealTime(): void {
	vi.useRealTimers();
}
