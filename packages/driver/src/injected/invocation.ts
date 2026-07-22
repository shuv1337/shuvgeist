import type { InjectedArtifactDescriptor } from "./contracts.js";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function assertArtifact(artifact: InjectedArtifactDescriptor): void {
	if (!IDENTIFIER.test(artifact.globalName)) {
		throw new Error(`Invalid injected artifact global: ${artifact.globalName}`);
	}
	if (!artifact.source.trim()) {
		throw new Error(`Injected artifact ${artifact.globalName} has no source`);
	}
}

/**
 * Wrap an esbuild IIFE artifact as a callable function expression. Argument
 * sources are JavaScript expressions because browserjs user functions and
 * provider setup code must be parsed by the target user-script world.
 */
export function buildInjectedArtifactFunction(
	artifact: InjectedArtifactDescriptor,
	argumentSources: readonly string[] = ["...arguments"],
): string {
	assertArtifact(artifact);
	return `async function() {
${artifact.source}
return await ${artifact.globalName}.run(${argumentSources.join(", ")});
}`;
}

export function buildInjectedArtifactInvocation(
	artifact: InjectedArtifactDescriptor,
	argumentSources: readonly string[],
): string {
	return `(${buildInjectedArtifactFunction(artifact, argumentSources)})()`;
}
