import { createSnapshotArtifactSurface } from "../../../dist-cli/driver-injected-artifacts.mjs";

const serializedConfig = process.argv[2];
if (!serializedConfig) throw new Error("Expected a serialized snapshot config argument");

process.stdout.write(JSON.stringify(createSnapshotArtifactSurface(JSON.parse(serializedConfig))));
