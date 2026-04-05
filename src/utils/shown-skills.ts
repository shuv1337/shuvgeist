const shownSkills = new Map<string, string>();

export function getShownSkills(): Map<string, string> {
	return shownSkills;
}

export function clearShownSkills(): void {
	shownSkills.clear();
}
