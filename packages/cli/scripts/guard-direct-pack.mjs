console.error(
	"Direct packing of packages/cli is disabled because its package.json describes the source workspace. Run `npm run package:cli` from the repository root to build the dependency-free public package.",
);
process.exitCode = 1;
