#!/bin/bash
set -e

BUMP_TYPE="$1"

if [ "$BUMP_TYPE" != "major" ] && [ "$BUMP_TYPE" != "minor" ] && [ "$BUMP_TYPE" != "patch" ]; then
    echo "Usage: ./release.sh <major|minor|patch>"
    exit 1
fi

# Check for uncommitted changes
if [ -n "$(git status --porcelain)" ]; then
    echo "Error: uncommitted changes. Commit or stash first."
    exit 1
fi

# Read current version from manifest
MANIFEST="static/manifest.chrome.json"
CURRENT=$(node -p "require('./$MANIFEST').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP_TYPE" in
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    patch) PATCH=$((PATCH + 1)) ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
TAG="v$NEW_VERSION"
DATE=$(date +%Y-%m-%d)

echo "Bumping version: $CURRENT -> $NEW_VERSION"

# Update the core release unit. proxy/ and site/ are independent-version
# workspaces and keep their own nested lockfiles.
node - "$NEW_VERSION" <<'NODE'
const fs = require('fs');
const nextVersion = process.argv[2];
const packagePaths = [
    'package.json',
    'packages/protocol/package.json',
    'packages/driver/package.json',
    'packages/extension/package.json',
    'packages/server/package.json',
    'packages/cli/package.json',
];
const internalNames = new Set([
    '@shuvgeist/protocol',
    '@shuvgeist/driver',
    '@shuvgeist/extension',
    '@shuvgeist/server',
    'shuvgeist',
]);
for (const packagePath of packagePaths) {
    const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    manifest.version = nextVersion;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const dependencyName of Object.keys(manifest[section] ?? {})) {
            if (internalNames.has(dependencyName)) manifest[section][dependencyName] = nextVersion;
        }
    }
    fs.writeFileSync(packagePath, JSON.stringify(manifest, null, '\t') + '\n');
}
const chromeManifest = JSON.parse(fs.readFileSync('static/manifest.chrome.json', 'utf8'));
chromeManifest.version = nextVersion;
fs.writeFileSync('static/manifest.chrome.json', JSON.stringify(chromeManifest, null, '\t') + '\n');
NODE

# Refresh the root workspace lock after the package graph/version update.
npm install --package-lock-only --ignore-scripts

# Update CHANGELOG: replace [Unreleased] with version, add new [Unreleased]
node -e "
const fs = require('fs');
let changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
changelog = changelog.replace('## [Unreleased]', '## [Unreleased]\n\n## [$NEW_VERSION] - $DATE');
fs.writeFileSync('CHANGELOG.md', changelog);
"

# Run checks
echo "Running checks..."
./check.sh

# Commit, tag, push
git add "$MANIFEST" CHANGELOG.md package.json package-lock.json packages/protocol/package.json packages/driver/package.json packages/extension/package.json packages/server/package.json packages/cli/package.json
git commit -m "Release v$NEW_VERSION"
git tag "$TAG"
git push origin main
git push origin "$TAG"

echo ""
echo "Released v$NEW_VERSION"
echo "GitHub Actions will build and create the release at:"
echo "  https://github.com/shuv1337/shuvgeist/releases/tag/$TAG"
