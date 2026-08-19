import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'release', 'mac-arm64', 'Workbench.app');

/**
 * Ad-hoc signature (`-s -`). Enough for a locally built personal app: macOS will
 * launch it without Gatekeeper complaining about an unsigned binary, and no
 * Developer ID or notarization is involved (architecture §9).
 *
 * --deep is deprecated but still the practical way to cover the nested Electron
 * frameworks and helpers in one pass for an ad-hoc signature.
 */
execFileSync('codesign', ['--force', '--deep', '--sign', '-', APP], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--verbose=2', APP], { stdio: 'inherit' });
console.log(`\nsigned ${path.relative(ROOT, APP)}`);
