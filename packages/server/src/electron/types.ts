/** Server-owned Electron process and session state. */
import type { ChildProcess } from "node:child_process";

export interface ElectronApp {
	id: string;
	aliases: string[];
	displayName: string;
	paths: Partial<Record<NodeJS.Platform, string[]>>;
	defaultArgs: string[];
	singleInstance: "strict" | "tolerant" | "unknown";
	mainInspectSupported: boolean;
	notes?: string;
}

export interface ElectronSession {
	id: string;
	/** Browser endpoint plus verified app process family and generation. */
	endpointKey: string;
	/** Normalized browser-level CDP websocket endpoint, without process identity. */
	browserEndpointKey: string;
	owner: ElectronProcessIdentity;
	appId?: string;
	appRef?: string;
	pid?: number;
	port: number;
	webSocketDebuggerUrl?: string;
	mainInspector?: ElectronMainInspector;
	browser?: string;
	launched: boolean;
	startedAt: string;
	process?: ChildProcess;
	launchProcessIdentityKey?: string;
	nextWindowNumber: number;
	windows: ElectronWindow[];
	ipcTaps: ElectronIpcTap[];
	mainNetworkTaps: ElectronMainNetworkTap[];
}

export interface ElectronMainInspector {
	port: number;
	webSocketDebuggerUrl?: string;
	available: boolean;
	browser?: string;
	ownerKey?: string;
}

export interface ElectronProcessIdentity {
	pid: number;
	parentPid?: number;
	generation: string;
	executablePath: string;
	familyKey: string;
}

export interface ElectronSessionSummary {
	id: string;
	appId?: string;
	appRef?: string;
	pid?: number;
	port: number;
	browser?: string;
	mainInspector?: ElectronMainInspector;
	launched: boolean;
	startedAt: string;
	windows: ElectronWindowSummary[];
}

export type ElectronSessionLivenessReason = "ok" | "cdp_unreachable" | "endpoint_changed" | "no_page_targets";

/**
 * A point-in-time, server-verified status for a tracked Electron session.
 * Cached windows remain useful diagnostics when live is false, but must not be
 * treated as currently controllable.
 */
export interface ElectronSessionStatusSummary extends ElectronSessionSummary {
	live: boolean;
	livePageTargetCount: number;
	livenessCheckedAt: string;
	livenessReason: ElectronSessionLivenessReason;
}

export interface ElectronWindow {
	ref: string;
	targetId: string;
	label?: string;
	type: string;
	title?: string;
	url?: string;
	webSocketDebuggerUrl: string;
	isPrimary: boolean;
	attachedAt: string;
	lastSeenAt: string;
	closed?: boolean;
}

export interface ElectronWindowSummary {
	ref: string;
	label?: string;
	type: string;
	title?: string;
	url?: string;
	isPrimary: boolean;
	closed?: boolean;
}

export interface ElectronRegistryEntry {
	id: string;
	aliases: string[];
	displayName: string;
	path?: string;
	installed: boolean;
	allowed: boolean;
	singleInstance: "strict" | "tolerant" | "unknown";
	mainInspectSupported: boolean;
	notes?: string;
}

export interface ElectronIpcTap {
	id: string;
	channel?: string;
	startedAt: string;
	active: boolean;
	warning: string;
}

export interface ElectronMainNetworkTap {
	id: string;
	startedAt: string;
	active: boolean;
	source: "main";
}
