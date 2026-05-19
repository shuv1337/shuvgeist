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
