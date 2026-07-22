import type { ReplOverlayAbortIntent } from "@shuvgeist/driver/injected-contracts";

const REPL_OVERLAY_STYLE_ID = "shuvgeist-repl-overlay-styles";

/** Creates the REPL activity overlay inside an injected user-script world. */
export function showReplOverlay(taskName: string, abortIntent: ReplOverlayAbortIntent): void {
	// Check if overlay already exists (prevent duplicates)
	if (document.getElementById("shuvgeist-repl-overlay")) {
		return;
	}

	// Create overlay container
	const overlay = document.createElement("div");
	overlay.id = "shuvgeist-repl-overlay";
	overlay.style.cssText = `
		position: fixed;
		top: 0;
		left: 0;
		width: 100vw;
		height: 100vh;
		z-index: 2147483647;
		pointer-events: none;
		font-family: system-ui, -apple-system, sans-serif;
	`;

	// Create shimmer backdrop with multiple layers
	const shimmerContainer = document.createElement("div");
	shimmerContainer.style.cssText = `
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
	`;

	// Vignette base - very subtle darkening at edges
	const vignette = document.createElement("div");
	vignette.style.cssText = `
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background: radial-gradient(
			ellipse at center,
			transparent 0%,
			transparent 50%,
			rgba(0, 0, 0, 0.02) 80%,
			rgba(0, 0, 0, 0.05) 100%
		);
	`;

	// Layer 1: Inner orange/red glow
	const layer1 = document.createElement("div");
	layer1.style.cssText = `
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background: radial-gradient(
			ellipse at center,
			transparent 0%,
			transparent 50%,
			rgba(255, 107, 0, 0.04) 65%,
			rgba(255, 69, 0, 0.06) 80%,
			rgba(220, 38, 38, 0.03) 100%
		);
		animation: shuvgeist-shimmer-radial-1 3s ease-in-out infinite;
	`;

	// Layer 2: Mid magenta/red layer
	const layer2 = document.createElement("div");
	layer2.style.cssText = `
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background: radial-gradient(
			ellipse at center,
			transparent 0%,
			transparent 55%,
			rgba(194, 24, 91, 0.05) 70%,
			rgba(219, 39, 119, 0.08) 85%,
			rgba(157, 23, 77, 0.04) 100%
		);
		animation: shuvgeist-shimmer-radial-2 4s ease-in-out infinite;
	`;

	// Layer 3: Outer violet/purple layer - most prominent
	const layer3 = document.createElement("div");
	layer3.style.cssText = `
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		background: radial-gradient(
			ellipse at center,
			transparent 0%,
			transparent 60%,
			rgba(147, 51, 234, 0.06) 75%,
			rgba(126, 34, 206, 0.12) 88%,
			rgba(107, 33, 168, 0.08) 100%
		);
		animation: shuvgeist-shimmer-radial-3 5s ease-in-out infinite;
	`;

	// Layer 4: Deep purple edge glow
	const borderGlow = document.createElement("div");
	borderGlow.style.cssText = `
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		box-shadow: inset 0 0 120px 20px rgba(126, 34, 206, 0.08),
		            inset 0 0 60px 10px rgba(147, 51, 234, 0.05);
		animation: shuvgeist-pulse 2s ease-in-out infinite;
	`;

	shimmerContainer.appendChild(vignette);
	shimmerContainer.appendChild(layer1);
	shimmerContainer.appendChild(layer2);
	shimmerContainer.appendChild(layer3);
	shimmerContainer.appendChild(borderGlow);

	// Create particle system
	const particleContainer = document.createElement("div");
	particleContainer.style.cssText = `
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
		pointer-events: none;
	`;

	// Generate 20 particles with random properties, concentrated at edges
	for (let i = 0; i < 20; i++) {
		const particle = document.createElement("div");
		const size = Math.random() * 2 + 1; // 1-3px (much smaller)

		// Bias particles towards edges (vignette effect)
		// Random angle around the circle
		const angle = Math.random() * Math.PI * 2;
		// Distance from center - heavily weighted towards edges (70-100% of radius)
		const distanceFromCenter = 70 + Math.random() * 30;
		// Convert polar to cartesian, centered at 50%, 50%
		const startX = 50 + Math.cos(angle) * distanceFromCenter * 0.7; // 0.7 for ellipse width
		const startY = 50 + Math.sin(angle) * distanceFromCenter;

		const duration = Math.random() * 12 + 10; // 10-22s (slower)
		const delay = Math.random() * 5; // 0-5s delay
		const opacity = Math.random() * 0.2 + 0.15; // 0.15-0.35 (much more subtle)

		// Random color - heavily favor violet/purple tones (matching reference)
		const colors = [
			"147, 51, 234", // purple (violet)
			"126, 34, 206", // deep purple
			"107, 33, 168", // darker purple
			"147, 51, 234", // purple (violet) - repeated for higher probability
			"168, 85, 247", // lighter purple
			"194, 24, 91", // magenta/pink
			"219, 39, 119", // bright pink
			"255, 69, 0", // red-orange
			"220, 38, 38", // red
		];
		const color = colors[Math.floor(Math.random() * colors.length)];

		particle.style.cssText = `
			position: absolute;
			left: ${startX}%;
			top: ${startY}%;
			width: ${size}px;
			height: ${size}px;
			background: rgba(${color}, ${opacity});
			border-radius: 50%;
			box-shadow: 0 0 ${size * 1.5}px rgba(${color}, ${opacity * 0.5});
			animation: shuvgeist-particle-float ${duration}s ease-in-out ${delay}s infinite;
		`;
		particleContainer.appendChild(particle);
	}

	shimmerContainer.appendChild(particleContainer);

	// Create toolbar
	const toolbar = document.createElement("div");
	toolbar.style.cssText = `
		position: absolute;
		bottom: 24px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		background: rgba(0, 0, 0, 0.9);
		backdrop-filter: blur(8px);
		border-radius: 8px;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
		pointer-events: auto;
		z-index: 1;
	`;

	// Task name label
	const label = document.createElement("span");
	label.textContent = taskName;
	label.style.cssText = `
		color: rgba(255, 255, 255, 0.9);
		font-size: 14px;
		font-weight: 500;
	`;

	// Abort button
	const abortBtn = document.createElement("button");
	abortBtn.textContent = "Stop";
	abortBtn.style.cssText = `
		padding: 6px 12px;
		background: rgba(239, 68, 68, 0.9);
		color: white;
		border: none;
		border-radius: 4px;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.2s;
	`;
	abortBtn.onmouseover = () => {
		abortBtn.style.background = "rgba(220, 38, 38, 1)";
	};
	abortBtn.onmouseout = () => {
		abortBtn.style.background = "rgba(239, 68, 68, 0.9)";
	};
	abortBtn.onclick = async () => {
		try {
			await chrome.runtime.sendMessage({ type: "agent-runtime-abort-intent", intent: abortIntent });
		} catch (error) {
			console.error("[Overlay] sendMessage failed:", error);
		}
		overlay.remove();
		document.getElementById(REPL_OVERLAY_STYLE_ID)?.remove();
	};

	// Assemble toolbar
	toolbar.appendChild(label);
	toolbar.appendChild(abortBtn);

	// Assemble overlay
	overlay.appendChild(shimmerContainer);
	overlay.appendChild(toolbar);

	// Add CSS animations
	const style = document.createElement("style");
	style.id = REPL_OVERLAY_STYLE_ID;
	style.textContent = `
		@keyframes shuvgeist-shimmer-radial-1 {
			0%, 100% {
				opacity: 0.8;
				transform: scale(1);
			}
			50% {
				opacity: 1;
				transform: scale(1.02);
			}
		}

		@keyframes shuvgeist-shimmer-radial-2 {
			0%, 100% {
				opacity: 0.7;
				transform: scale(1) rotate(0deg);
			}
			50% {
				opacity: 0.9;
				transform: scale(1.03) rotate(2deg);
			}
		}

		@keyframes shuvgeist-shimmer-radial-3 {
			0%, 100% {
				opacity: 0.75;
				transform: scale(1.01);
			}
			50% {
				opacity: 0.9;
				transform: scale(1);
			}
		}

		@keyframes shuvgeist-pulse {
			0%, 100% {
				box-shadow: inset 0 0 120px 20px rgba(126, 34, 206, 0.08),
				            inset 0 0 60px 10px rgba(147, 51, 234, 0.05);
			}
			50% {
				box-shadow: inset 0 0 140px 25px rgba(126, 34, 206, 0.11),
				            inset 0 0 70px 12px rgba(147, 51, 234, 0.07);
			}
		}

		@keyframes shuvgeist-particle-float {
			0%, 100% {
				transform: translate(0, 0) scale(1);
				opacity: 1;
			}
			25% {
				transform: translate(8px, -12px) scale(1.1);
				opacity: 0.8;
			}
			50% {
				transform: translate(-5px, -20px) scale(0.9);
				opacity: 0.6;
			}
			75% {
				transform: translate(10px, -15px) scale(1.05);
				opacity: 0.9;
			}
		}
	`;
	document.head.appendChild(style);

	// Inject into page
	document.body.appendChild(overlay);
}

/** Removes the REPL activity overlay from an injected user-script world. */
export function removeReplOverlay(): void {
	const overlay = document.getElementById("shuvgeist-repl-overlay");
	if (overlay) {
		overlay.remove();
	}
	document.getElementById(REPL_OVERLAY_STYLE_ID)?.remove();
}
