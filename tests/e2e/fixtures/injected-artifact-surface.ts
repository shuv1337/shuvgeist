import type { InjectedArtifactDescriptor } from "@shuvgeist/driver/injected-contracts";
import { buildInjectedArtifactInvocation } from "@shuvgeist/driver/injected-invocation";

export interface InjectedArtifactDescriptorSurface {
	artifactVersion: number;
	contentHash: string;
	globalName: string;
	sourceBytes: number;
}

export interface InjectedArtifactInvocationSurface extends InjectedArtifactDescriptorSurface {
	expression: string;
}

function serializeArgument(value: unknown): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new Error("Injected artifact arguments must be JSON-serializable");
	return serialized.replace(/</g, "\\u003c");
}

export function createArtifactDescriptorSurface(
	artifact: InjectedArtifactDescriptor,
): InjectedArtifactDescriptorSurface {
	return {
		artifactVersion: artifact.version,
		contentHash: artifact.contentHash,
		globalName: artifact.globalName,
		sourceBytes: new TextEncoder().encode(artifact.source).byteLength,
	};
}

export function createArtifactInvocationSurface(
	artifact: InjectedArtifactDescriptor,
	argument: unknown,
): InjectedArtifactInvocationSurface {
	return {
		...createArtifactDescriptorSurface(artifact),
		expression: buildInjectedArtifactInvocation(artifact, [serializeArgument(argument)]),
	};
}
