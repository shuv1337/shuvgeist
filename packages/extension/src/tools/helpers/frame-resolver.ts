export const MAIN_FRAME_ID = 0;
export const NO_PARENT_FRAME_ID = -1;

export interface FrameDescriptor {
	frameId: number;
	parentFrameId: number;
	url: string;
	errorOccurred?: boolean;
}

export interface FrameTreeNode extends FrameDescriptor {
	depth: number;
	path: string;
	children: FrameTreeNode[];
}

export interface FrameTree {
	roots: FrameTreeNode[];
	orphans: FrameTreeNode[];
	byFrameId: Map<number, FrameTreeNode>;
}

export type FrameResolutionResult =
	| {
			ok: true;
			reason: "explicit" | "default-main";
			frame: FrameDescriptor;
	  }
	| {
			ok: false;
			reason: "main-frame-missing" | "frame-not-found";
			message: string;
			availableFrameIds: number[];
	  };

function normalizeUrl(url: string | undefined): string {
	return typeof url === "string" ? url : "";
}

export function normalizeFrameDescriptors(frames: ReadonlyArray<Partial<FrameDescriptor>>): FrameDescriptor[] {
	return frames
		.filter((frame): frame is Partial<FrameDescriptor> & { frameId: number } => typeof frame.frameId === "number")
		.map((frame) => ({
			frameId: frame.frameId,
			parentFrameId: typeof frame.parentFrameId === "number" ? frame.parentFrameId : NO_PARENT_FRAME_ID,
			url: normalizeUrl(frame.url),
			errorOccurred: Boolean(frame.errorOccurred),
		}))
		.sort((a, b) => a.frameId - b.frameId);
}

export function buildFrameTree(frames: ReadonlyArray<FrameDescriptor>): FrameTree {
	const normalized = normalizeFrameDescriptors(frames);
	const byFrameId = new Map<number, FrameTreeNode>();
	for (const frame of normalized) {
		byFrameId.set(frame.frameId, {
			...frame,
			depth: 0,
			path: "",
			children: [],
		});
	}

	const roots: FrameTreeNode[] = [];
	const orphans: FrameTreeNode[] = [];

	for (const node of byFrameId.values()) {
		if (node.parentFrameId === NO_PARENT_FRAME_ID) {
			roots.push(node);
			continue;
		}
		const parent = byFrameId.get(node.parentFrameId);
		if (!parent) {
			orphans.push(node);
			roots.push(node);
			continue;
		}
		parent.children.push(node);
	}

	const stableSort = (nodes: FrameTreeNode[]) => nodes.sort((a, b) => a.frameId - b.frameId);
	const assignPathAndDepth = (node: FrameTreeNode, depth: number, parentPath: string | null) => {
		node.depth = depth;
		node.path = parentPath === null ? `${node.frameId}` : `${parentPath}/${node.frameId}`;
		stableSort(node.children);
		for (const child of node.children) {
			assignPathAndDepth(child, depth + 1, node.path);
		}
	};

	stableSort(roots);
	stableSort(orphans);
	for (const root of roots) {
		assignPathAndDepth(root, 0, null);
	}

	return { roots, orphans, byFrameId };
}

export function resolveFrameTarget(
	frames: ReadonlyArray<FrameDescriptor>,
	requestedFrameId?: number,
): FrameResolutionResult {
	const normalized = normalizeFrameDescriptors(frames);
	const byId = new Map<number, FrameDescriptor>(normalized.map((frame) => [frame.frameId, frame]));
	const availableFrameIds = normalized.map((frame) => frame.frameId);

	if (typeof requestedFrameId === "number") {
		const frame = byId.get(requestedFrameId);
		if (!frame) {
			return {
				ok: false,
				reason: "frame-not-found",
				message: `Frame ${requestedFrameId} was not found`,
				availableFrameIds,
			};
		}
		return { ok: true, reason: "explicit", frame };
	}

	const mainFrame = byId.get(MAIN_FRAME_ID);
	if (!mainFrame) {
		return {
			ok: false,
			reason: "main-frame-missing",
			message: "Main frame (0) was not found",
			availableFrameIds,
		};
	}
	return { ok: true, reason: "default-main", frame: mainFrame };
}

export async function listFrames(tabId: number): Promise<FrameDescriptor[]> {
	const frames = await chrome.webNavigation.getAllFrames({ tabId });
	if (!frames) return [];
	return normalizeFrameDescriptors(frames);
}
