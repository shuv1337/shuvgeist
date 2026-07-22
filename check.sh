#!/bin/bash
set -e
node ./scripts/injected-artifacts.mjs --check
npm run check
