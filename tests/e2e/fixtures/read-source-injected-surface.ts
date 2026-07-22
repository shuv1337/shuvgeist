import { createSnapshotArtifactSurface } from "./driver-injected-artifact-surface.js";
import type { SnapshotInjectionConfig } from "@shuvgeist/driver/injected-contracts";

const serializedConfig = process.argv[2];
if (!serializedConfig) throw new Error("Expected a serialized snapshot config argument");

const config = JSON.parse(serializedConfig) as SnapshotInjectionConfig;
process.stdout.write(JSON.stringify(createSnapshotArtifactSurface(config)));
