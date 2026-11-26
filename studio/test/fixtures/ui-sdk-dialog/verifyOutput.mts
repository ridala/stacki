// Check the production Astro HTML before JavaScript runs. The standalone route
// must contain its copy and metadata, while the overview needs no React island.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const overview = readFileSync(new URL('./dist/index.html', import.meta.url), 'utf8');
const dialog = readFileSync(new URL('./dist/dialog/index.html', import.meta.url), 'utf8');

assert.match(overview, /<title>Project overview<\/title>/);
assert.doesNotMatch(overview, /<astro-island\b/);
assert.match(dialog, /<title>Project details<\/title>/);
assert.match(dialog, /<link rel="canonical" href="https:\/\/example\.test\/dialog\/?">/);
assert.match(dialog, /<h1>Project details<\/h1>/);
assert.match(dialog, /<p>The project is open for review\.<\/p>/);
assert.match(dialog, /<a href="\/">Back to the overview<\/a>/);
assert.match(dialog, /<astro-island\b/);
assert.match(dialog, /<button[^>]*>Review notes<\/button>/);
assert.doesNotMatch(dialog, /<meta[^>]*\bnoindex\b/i);
