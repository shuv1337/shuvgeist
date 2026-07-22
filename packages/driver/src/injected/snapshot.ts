import { shuvgeistSnapshotPageScript } from "../snapshot-page-script.js";
import type { SnapshotInjectionConfig, SnapshotInjectionResponse } from "./contracts.js";

export function run(config: SnapshotInjectionConfig): SnapshotInjectionResponse {
	return shuvgeistSnapshotPageScript(config);
}
