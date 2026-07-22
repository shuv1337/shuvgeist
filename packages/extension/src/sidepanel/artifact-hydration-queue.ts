/**
 * Runs artifact reconstructions one at a time and deduplicates only work that
 * is pending or completed successfully. Failed work remains retryable.
 */
export class ArtifactHydrationQueue {
	private tail: Promise<void> = Promise.resolve();
	private readonly pending = new Map<string, Promise<void>>();
	private lastCompletedSignature: string | undefined;

	enqueue(signature: string, hydrate: () => Promise<void>, force = false): Promise<void> {
		const pending = this.pending.get(signature);
		if (pending) return pending;
		if (!force && signature === this.lastCompletedSignature) return Promise.resolve();

		const hydration = this.tail
			.catch(() => undefined)
			.then(hydrate)
			.then(() => {
				this.lastCompletedSignature = signature;
			});
		this.tail = hydration;
		this.pending.set(signature, hydration);
		void hydration
			.finally(() => {
				if (this.pending.get(signature) === hydration) this.pending.delete(signature);
			})
			.catch(() => undefined);
		return hydration;
	}
}
