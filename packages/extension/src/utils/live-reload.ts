// Dev mode hot reload — only active when built with --watch (NODE_ENV=development)
if (process.env.NODE_ENV === "development") {
	const connectWebSocket = () => {
		try {
			const ws = new WebSocket("ws://localhost:8765");

			ws.onopen = () => {
				console.log("[HotReload] Connected to dev server");
			};

			ws.onmessage = (event) => {
				const data = JSON.parse(event.data);
				if (data.type === "reload") {
					console.log("[HotReload] Reloading extension...");
					chrome.runtime.reload();
				}
			};

			ws.onerror = () => {
				// Silent fail - dev server might not be running
			};

			ws.onclose = () => {
				// Reconnect after 2 seconds
				setTimeout(connectWebSocket, 2000);
			};
		} catch (_e) {
			// Silent fail if WebSocket not available
		}
	};
	connectWebSocket();
}
