// Goal: both setup commands and their report agree on the wire format.
// Method: round-trip valid requests and refuse malformed nested values, unsafe paths and out-of-budget lists.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import { PROJECT_SETUP_ENTRIES_MAX, parseProjectSetupResult } from '#dist/shared/ipc/projectSetup.js';

const projectPath = '/projects/site';
const revision = 'a'.repeat(64);
const suggestion = {
  kind: 'components',
  folders: ['src/components', 'src/ui'],
  desktopBefore: 0,
  desktopAfter: 1,
  studioBefore: 3,
  studioAfter: 1,
  desktopAdded: ['src/ui/Teaser.astro'],
  studioAdded: [],
  studioRemoved: ['public/Legacy.astro', 'src/Legacy.astro'],
};
const report = {
  revision,
  pagesFolder: 'src/pages',
  pagesSource: 'default',
  desktopPages: 1,
  studioPages: 1,
  incomplete: false,
  settings: 'editable',
  suggestions: [suggestion],
};

test('project setup IPC parses an exact revision and a bounded list of selected kinds', () => {
  assert.deepEqual(parseIpcPayload('project:setupScan', { projectPath }), { projectPath });
  const confirmation = { projectPath, permission: 'confirm-open' };
  assert.deepEqual(parseIpcPayload('project:setupScan', confirmation), confirmation);
  assert.throws(() => parseIpcPayload('project:setupScan', { projectPath, permission: 'grant' }));
  const input = { projectPath, revision, kinds: ['components', 'layouts'] };
  assert.deepEqual(parseIpcPayload('project:setupApply', input), input);
  for (const changes of [
    { projectPath: '../site' },
    { revision: 'missing' },
    { kinds: ['components', 'components'] },
    { kinds: ['pages'] },
    { kinds: 'components' },
    { kinds: Array.from({ length: 6 }, () => 'components') },
  ]) {
    assert.throws(() => parseIpcPayload('project:setupApply', { ...input, ...changes }));
  }
});

test('project setup reports refuse invalid counts and folder mappings', () => {
  assert.deepEqual(parseProjectSetupResult({ ok: true, value: report }), { ok: true, value: report });
  const stale = { ok: false, error: { code: 'stale', message: 'Review again.' } };
  assert.deepEqual(parseProjectSetupResult(stale), stale);
  for (const changes of [
    { pagesSource: 'computed' },
    { pagesFolder: '../pages' },
    { desktopPages: -1 },
    { studioPages: PROJECT_SETUP_ENTRIES_MAX + 1 },
    { incomplete: true },
    { settings: 'unavailable' },
    { suggestions: [suggestion, suggestion] },
    { suggestions: [{ ...suggestion, studioAfter: 1.5 }] },
    { suggestions: [{ ...suggestion, folders: ['src', 'src/ui'] }] },
    { suggestions: [{ ...suggestion, folders: ['src/ui', 'src/ui/headers'] }] },
    { suggestions: [{ ...suggestion, desktopAdded: ['src/../Outside.astro'] }] },
    { suggestions: [{ ...suggestion, studioRemoved: Array.from({ length: 4 }, () => 'src/Legacy.astro') }] },
  ]) {
    assert.throws(() => parseProjectSetupResult({ ok: true, value: { ...report, ...changes } }));
  }
});
