// Verifies modern CSS at-rules (`@theme`, `@variant`), monorepo workspace `@import` discovery
// and in-place editing, and read-only `node_modules` library defaults with automatic local overrides.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { addSection, addVariable, readDeclarations, readVariables, setVariable } from '#dist/electron/project/cssVars.js';

function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

test('reads and edits @theme inline and @layer theme { @variant light } declarations in place', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-css-atrules-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const css = [
    '@theme inline {',
    '  --color-primary: #112233;',
    '  --font-sans: Inter, sans-serif;',
    '}',
    '',
    '@layer theme {',
    '  @variant light {',
    '    --accent: oklch(0.6 0.15 240);',
    '    --surface: #ffffff;',
    '  }',
    '}',
    '',
  ].join('\n');
  writeFiles(project, { 'src/styles/tokens.css': css });

  const rules = readDeclarations(css);
  assert.deepEqual(
    rules.map((rule) => rule.selector),
    ['@theme inline', '@variant light'],
  );
  const model = readVariables(project);
  const file = model.files.find((entry) => entry.rel === 'src/styles/tokens.css');
  assert.ok(file);
  const cells = file.groups.flatMap((group) => group.blocks.flatMap((block) => block.rows.flatMap((row) => row.cells)));
  const accent = cells.find((cell) => cell?.name === '--accent');
  assert.ok(accent);
  assert.equal(accent.value, 'oklch(0.6 0.15 240)');

  const edit = setVariable(project, {
    file: accent.file,
    valueStart: accent.valueStart,
    valueEnd: accent.valueEnd,
    expect: accent.value,
    value: 'oklch(0.55 0.18 250)',
  });
  assert.equal(edit.ok, true);
  assert.match(fs.readFileSync(path.join(project, 'src/styles/tokens.css'), 'utf8'), /--accent: oklch\(0\.55 0\.18 250\);/);
});

test('follows monorepo workspace @import stylesheets and edits them safely in place', (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-css-workspace-'));
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  writeFiles(workspace, {
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
    'package.json': JSON.stringify({ name: 'demo-mono', private: true }),
    'packages/brand/package.json': JSON.stringify({
      name: '@demo/brand',
      exports: {
        './tokens.css': './tokens.css',
      },
    }),
    'packages/brand/tokens.css': '@layer theme {\n  @variant light {\n    --brand-accent: #0055ff;\n  }\n}\n',
    'apps/site/package.json': JSON.stringify({
      name: '@demo/site',
      dependencies: { '@demo/brand': 'workspace:*', astro: '^5.0.0' },
    }),
    'apps/site/src/styles/global.css': '@import "tailwindcss";\n@import "@demo/brand/tokens.css";\n',
  });

  const appRoot = path.join(workspace, 'apps/site');
  const model = readVariables(appRoot);
  const sharedFile = model.files.find((entry) => entry.sourceKind === 'workspace');
  assert.ok(sharedFile, 'workspace stylesheet should be discovered');
  assert.equal(sharedFile.name, '@demo/brand/tokens.css');

  const accent = sharedFile.groups
    .flatMap((group) => group.blocks.flatMap((block) => block.rows.flatMap((row) => row.cells)))
    .find((cell) => cell?.name === '--brand-accent');
  assert.ok(accent);
  assert.equal(accent.value, '#0055ff');

  const result = setVariable(appRoot, {
    file: accent.file,
    valueStart: accent.valueStart,
    valueEnd: accent.valueEnd,
    expect: accent.value,
    value: '#ff3300',
  });
  assert.equal(result.ok, true);
  assert.match(fs.readFileSync(path.join(workspace, 'packages/brand/tokens.css'), 'utf8'), /--brand-accent: #ff3300;/);

  // Refuses paths outside the enclosing workspace.
  const escape = setVariable(appRoot, {
    file: '../../../../etc/hosts',
    valueStart: 0,
    valueEnd: 0,
    value: 'bad',
  });
  assert.equal(escape.ok, false);
});

test('reads node_modules library defaults and writes local overrides without mutating node_modules', (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-css-library-'));
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const libraryVarsSource = [
    ':root, [data-theme="light"] {',
    '  --accent: #3b82f6;',
    '  --danger: #ef4444;',
    '}',
    '.dark, [data-theme="dark"] {',
    '  --danger: #f87171;',
    '}',
    '',
  ].join('\n');
  writeFiles(workspace, {
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
    'package.json': JSON.stringify({ name: 'demo-mono', private: true }),
    'node_modules/tailwindcss/package.json': JSON.stringify({ name: 'tailwindcss', exports: { '.': './index.css' } }),
    'node_modules/tailwindcss/index.css': ':root { --color-red-500: #ef4444; }\n',
    'node_modules/@heroui/styles/package.json': JSON.stringify({
      name: '@heroui/styles',
      exports: { './css': { style: './dist/index.css', default: './dist/index.css' } },
    }),
    'node_modules/@heroui/styles/dist/index.css': '@import "./themes/default/variables.css";\n',
    'node_modules/@heroui/styles/dist/themes/default/variables.css': libraryVarsSource,
    'apps/landing/package.json': JSON.stringify({ name: '@demo/landing', dependencies: { astro: '^5.0.0', '@heroui/styles': '^3.0.0' } }),
    'apps/landing/src/styles/global.css': '@import "tailwindcss";\n@import "@heroui/styles/css";\n\n:root {\n  --accent: #111111;\n}\n',
  });

  const appRoot = path.join(workspace, 'apps/landing');
  const libraryVarsPath = path.join(workspace, 'node_modules/@heroui/styles/dist/themes/default/variables.css');
  const model = readVariables(appRoot);

  // Tailwind utility engine is excluded.
  assert.equal(
    model.files.some((entry) => entry.rel.includes('tailwindcss')),
    false,
  );
  // Library defaults are discovered and omit `--accent` because the project already overrides it locally.
  const libraryFile = model.files.find((entry) => entry.sourceKind === 'library');
  assert.ok(libraryFile, 'library defaults stylesheet should be discovered');
  assert.equal(libraryFile.overrideTarget, 'src/styles/global.css');
  const libraryCells = libraryFile.groups.flatMap((group) => group.blocks.flatMap((block) => block.rows.flatMap((row) => row.cells)));
  assert.equal(
    libraryCells.some((cell) => cell?.name === '--accent'),
    false,
    'already-overridden variable should not duplicate in library defaults',
  );
  const dangerLight = libraryCells.find((cell) => cell?.name === '--danger' && cell.selector.includes(':root'));
  const dangerDark = libraryCells.find((cell) => cell?.name === '--danger' && cell.selector.includes('.dark'));
  assert.ok(dangerLight);
  assert.ok(dangerDark);

  // Structural mutations on read-only library defaults are refused.
  assert.equal(addVariable(appRoot, { file: libraryFile.rel, selector: ':root', name: '--new-var', value: '1px' }).ok, false);
  assert.equal(addSection(appRoot, { file: libraryFile.rel, selector: ':root', title: 'Custom' }).ok, false);

  // Editing light `--danger` writes into the existing `:root` rule of `src/styles/global.css` and leaves node_modules untouched.
  const lightEdit = setVariable(appRoot, {
    file: dangerLight.file,
    valueStart: dangerLight.valueStart,
    valueEnd: dangerLight.valueEnd,
    expect: dangerLight.value,
    value: '#dc2626',
  });
  assert.equal(lightEdit.ok, true);
  assert.equal(lightEdit.writtenFile, 'src/styles/global.css');
  assert.equal(fs.readFileSync(libraryVarsPath, 'utf8'), libraryVarsSource, 'node_modules file must stay byte-identical');
  const afterLight = fs.readFileSync(path.join(appRoot, 'src/styles/global.css'), 'utf8');
  assert.match(afterLight, /:root\s*\{[\s\S]*--accent: #111111;[\s\S]*--danger: #dc2626;[\s\S]*\}/);

  // Editing dark `--danger` creates a dark override block in `src/styles/global.css` and leaves node_modules untouched.
  const darkEdit = setVariable(appRoot, {
    file: dangerDark.file,
    valueStart: dangerDark.valueStart,
    valueEnd: dangerDark.valueEnd,
    expect: dangerDark.value,
    value: '#fca5a5',
  });
  assert.equal(darkEdit.ok, true);
  assert.equal(fs.readFileSync(libraryVarsPath, 'utf8'), libraryVarsSource, 'node_modules file must stay byte-identical');
  const afterDark = fs.readFileSync(path.join(appRoot, 'src/styles/global.css'), 'utf8');
  assert.match(afterDark, /\.dark,\s*\[data-theme="dark"\]\s*\{\s*--danger: #fca5a5;\s*\}/);
});
