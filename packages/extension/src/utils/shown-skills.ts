/**
 * Tracks the most recent version of each skill shown within one agent scope.
 *
 * Callers own the lifecycle of this state. Keeping it instance-local prevents
 * one session or browser window from suppressing skill details in another.
 */
export class ShownSkillsState {
	private readonly lastShownByName = new Map<string, string>();

	get(skillName: string): string | undefined {
		return this.lastShownByName.get(skillName);
	}

	set(skillName: string, lastUpdated: string): void {
		this.lastShownByName.set(skillName, lastUpdated);
	}

	clear(): void {
		this.lastShownByName.clear();
	}
}
