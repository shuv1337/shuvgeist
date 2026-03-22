// Apply theme immediately to prevent white flash
// This runs before any other scripts or CSS
(function() {
	const theme = localStorage.getItem('theme') || 'dark';
	if (theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
		document.documentElement.classList.add('dark');
	}
})();
