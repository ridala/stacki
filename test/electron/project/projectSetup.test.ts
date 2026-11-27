// Goal: setup predicts each editor's own discovery and saves only reviewed, current folder mappings.
// Method: use real temporary project files with divergent host rules, native grants, stale revisions and blocked paths.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyProjectSetup, scanProjectSetup } from '#dist/electron/project/projectSetup.js';
import { createProjectSetupAccess } from '#dist/electron/handlers/projectSetupHandlers.js';
import { parseProjectSetupApply, parseProjectSetupResult } from '#dist/shared/ipc/projectSetup.js';

function fixture(context: TestContext) {
  const projectPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-setup-')));
  context.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
  return {
    projectPath,
    file: (relative: string) => path.join(projectPath, relative),
    write(relative: string, text: string) {
      const file = path.join(projectPath, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    },
  };
}

test('setup recognizes static imports in arbitrary folders and reports Studio narrowing', (context) => {
  const { projectPath, file, write } = fixture(context);
  const page = '---\nimport Teaser from "../sections/Teaser.astro";\n---\n<main><Teaser /></main>';
  write('src/pages/index.astro', page);
  write('src/pages/_helper.astro', '<p>Astro ignores this as a route</p>');
  write('src/pages/notes.MD', '# Notes');
  write('src/sections/Teaser.astro', '<aside />');
  write('src/sections/hidden.md', '# Not a component');
  write('src/layouts/Shell.astro', '<slot />');
  write('public/Legacy.astro', '<p>Studio discovers this</p>');
  write('.git/info/exclude', '# Existing exclusion\n');

  const report = scanProjectSetup(projectPath);
  assert.deepEqual(scanProjectSetup(projectPath), report);
  assert.deepEqual(parseProjectSetupResult({ ok: true, value: report }), { ok: true, value: report });
  assert.equal(report.pagesSource, 'default');
  assert.equal(report.desktopPages, 2);
  assert.equal(report.studioPages, 2);
  assert.equal(report.incomplete, false);
  assert.deepEqual(report.suggestions, [
    {
      kind: 'components',
      folders: ['src/components', 'src/sections'],
      desktopBefore: 1,
      desktopAfter: 2,
      studioBefore: 3,
      studioAfter: 2,
      desktopAdded: ['src/sections/Teaser.astro'],
      studioAdded: [],
      studioRemoved: ['public/Legacy.astro'],
    },
  ]);
  assert.equal(fs.existsSync(file('.stacki')), false);

  const request = parseProjectSetupApply({ projectPath, revision: report.revision, kinds: ['components'] });
  let announced = 0;
  const announce = () => {
    announced += 1;
  };
  const applied = applyProjectSetup(projectPath, request, announce);
  assert.equal(applied.ok, true);
  assert.equal(announced, 1);
  const contents = fs.readFileSync(file('.stacki/folders.json'), 'utf8');
  assert.deepEqual(JSON.parse(contents), { version: 1, folders: { components: ['src/components', 'src/sections'] } });
  assert.equal(applyProjectSetup(projectPath, request, announce).ok, false);
  assert.equal(announced, 1);
  assert.equal(fs.readFileSync(file('.stacki/folders.json'), 'utf8'), contents);
  assert.equal(fs.readFileSync(file('.git/info/exclude'), 'utf8'), '# Existing exclusion\n');
  assert.equal(fs.readFileSync(file('src/pages/index.astro'), 'utf8'), page);
});

test('literal source roots and the two editors retain their different page rules', (context) => {
  const { projectPath, write } = fixture(context);
  write('astro.config.ts', 'import { defineConfig } from "astro/config"; export default defineConfig({ srcDir: "./website" });');
  write('website/pages/index.astro', '<main />');
  write('website/pages/blog/[slug].mdx', '# Blog');
  write('src/pages/stale.astro', '<p>Studio page</p>');
  write('src/ui/Card.astro', '<article />');
  const report = scanProjectSetup(projectPath);
  assert.equal(report.pagesFolder, 'website/pages');
  assert.equal(report.pagesSource, 'literal');
  assert.equal(report.desktopPages, 2);
  assert.equal(report.studioPages, 1);
  assert.equal(report.suggestions[0]?.studioBefore, 1);
});

test('computed, invalid, unreadable, and conflicting configs leave setup unverified', (context) => {
  const { projectPath, file, write } = fixture(context);
  write('src/pages/index.astro', '<main />');
  write('src/ui/Card.astro', '<article />');
  for (const config of [
    'export default { srcDir: process.env.SOURCE };',
    'export default { srcDir: "../outside" };',
    'export default { srcDir: "./site"',
    'export default makeConfig({ srcDir: "./src" });',
    'export default { ...defaults };',
  ]) {
    write('astro.config.mjs', config);
    const report = scanProjectSetup(projectPath);
    assert.equal(report.pagesSource, 'unverified', config);
    assert.equal(report.incomplete, false);
    assert.deepEqual(report.suggestions, []);
  }
  write('astro.config.mjs', 'export default {};');
  write('astro.config.ts', 'export default {};');
  assert.equal(scanProjectSetup(projectPath).pagesSource, 'unverified');
  fs.rmSync(file('astro.config.ts'));
  fs.rmSync(file('astro.config.mjs'));
  fs.mkdirSync(file('astro.config.mjs'));
  assert.equal(scanProjectSetup(projectPath).pagesSource, 'unverified');
  assert.equal(fs.existsSync(file('.stacki')), false);
});

test('setup preserves explicit empty, CMS, custom and unknown settings and rejects stale scans', (context) => {
  const { projectPath, file, write } = fixture(context);
  write('src/pages/index.astro', '<main />');
  write('src/ui/Card.astro', '<article />');
  write('src/templates/Shell.astro', '<slot />');
  const initial = {
    version: 1,
    folders: { components: [], styles: ['styles'], futurePanel: ['src/content'] },
    cms: { hiddenCollections: ['articles'], future: { label: 'CMS' } },
    futureEditor: true,
  };
  write('.stacki/folders.json', JSON.stringify(initial));
  const report = scanProjectSetup(projectPath);
  assert.deepEqual(
    report.suggestions.map(({ kind }) => kind),
    ['layouts'],
  );
  const request = parseProjectSetupApply({ projectPath, revision: report.revision, kinds: ['layouts'] });
  write('src/templates/Shell.astro', '<main><slot /></main>');
  const stale = applyProjectSetup(projectPath, request, () => assert.fail('Stale setup must stay read-only.'));
  assert.equal(stale.ok ? undefined : stale.error.code, 'stale');
  const fresh = scanProjectSetup(projectPath);
  const applied = applyProjectSetup(projectPath, parseProjectSetupApply({ ...request, revision: fresh.revision }), () => {});
  assert.equal(applied.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file('.stacki/folders.json'), 'utf8')), {
    ...initial,
    folders: { ...initial.folders, layouts: ['src/layouts', 'src/templates'] },
  });
});

test('setup reports broken settings, linked roots and file read limits without writing', (context) => {
  const { projectPath, file, write } = fixture(context);
  const outside = fixture(context);
  outside.write('folders.json', '{"version":1}');
  write('src/ui/Card.astro', '<article />');
  write('.stacki/folders.json', '{ invalid');
  assert.equal(scanProjectSetup(projectPath).settings, 'unavailable');
  fs.rmSync(file('.stacki'), { recursive: true });
  fs.symlinkSync(outside.projectPath, file('.stacki'), 'junction');
  assert.equal(scanProjectSetup(projectPath).settings, 'unavailable');
  fs.symlinkSync(outside.projectPath, file('src/linked'), 'junction');
  assert.equal(scanProjectSetup(projectPath).incomplete, true);
  fs.unlinkSync(file('src/linked'));
  write('src/ui/Huge.astro', 'x'.repeat(256 * 1024 + 1));
  const incomplete = scanProjectSetup(projectPath);
  assert.equal(incomplete.incomplete, true);
  assert.deepEqual(incomplete.suggestions, []);
  assert.equal(fs.readFileSync(outside.file('folders.json'), 'utf8'), '{"version":1}');
});

test('native grants expire, survive legitimate activation, and do not follow a replacement project', (context) => {
  const { projectPath } = fixture(context);
  const other = fixture(context);
  let now = 0;
  const access = createProjectSetupAccess(() => now);
  access.activate(other.projectPath);
  assert.equal(access.authorize(other.projectPath, other.projectPath), undefined);

  const abandoned = access.beginPicker();
  const accepted = access.beginPicker();
  access.acceptPicker(abandoned, other.projectPath);
  assert.equal(access.authorize(other.projectPath, undefined), undefined);
  access.acceptPicker(accepted, projectPath);
  const selected = access.authorize(projectPath, undefined);
  assert.ok(selected);
  assert.equal(access.authorize(other.projectPath, projectPath), undefined);
  now += 5 * 60_000;
  assert.equal(access.authorize(projectPath, undefined), undefined);

  access.acceptPicker(access.beginPicker(), projectPath);
  access.activate(projectPath);
  access.resetView();
  now += 5 * 60_000;
  assert.ok(access.authorize(projectPath, projectPath));
  assert.equal(access.authorize(projectPath, other.projectPath), undefined);
  fs.renameSync(projectPath, path.join(other.projectPath, 'original'));
  fs.mkdirSync(projectPath);
  assert.equal(access.authorize(projectPath, projectPath), undefined);
});

test('Settings can confirm only the open Astro folder through the native picker', (context) => {
  const { projectPath, write } = fixture(context);
  const other = fixture(context);
  const access = createProjectSetupAccess();
  write('astro.config.mjs', 'export default {};');
  other.write('astro.config.mjs', 'export default {};');

  access.activate(projectPath);
  assert.equal(access.authorize(projectPath, projectPath), undefined);
  access.confirmOpen(access.beginPicker(), projectPath, other.projectPath);
  assert.equal(access.authorize(projectPath, projectPath), undefined);
  assert.equal(access.authorize(other.projectPath, projectPath), undefined);

  const abandoned = access.beginPicker();
  access.resetView();
  access.confirmOpen(abandoned, projectPath, projectPath);
  assert.equal(access.authorize(projectPath, projectPath), undefined);
  access.confirmOpen(access.beginPicker(), projectPath, projectPath);
  assert.ok(access.authorize(projectPath, projectPath));
  assert.equal(access.authorize(projectPath, other.projectPath), undefined);
});
