// Exercise detection, stylesheet edits, and safe RTL changes against real temporary project files.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { changeShadcnSetting, readShadcnSettings } from '#dist/electron/project/shadcnSettings.js';
import { shadcnStarterLayout } from '#dist/electron/project/shadcnStarterContent.js';
import { shadcnThemePicker } from '#dist/electron/project/shadcnStarterTheme.js';

const config = {
  $schema: 'https://ui.shadcn.com/schema.json',
  style: 'base-nova',
  tailwind: { css: 'src/styles/global.css' },
  aliases: { ui: '@/components/ui' },
  rtl: true,
};

function site(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'stacki-shadcn-settings-'));
}

test('detects shadcn from project files and edits only the cursor declaration', async () => {
  const root = site();
  try {
    assert.deepEqual(readShadcnSettings(root), { ok: true, value: undefined });
    writeFileSync(path.join(root, 'components.json'), JSON.stringify(config));
    mkdirSync(path.join(root, 'src/styles'), { recursive: true });
    const file = path.join(root, config.tailwind.css);
    const original = '@layer base { button:not(:disabled), [role="button"]:not(:disabled) { color: red; } }\n';
    writeFileSync(file, original);
    assert.deepEqual(readShadcnSettings(root), { ok: true, value: { pointer: false, rtl: true } });
    assert.deepEqual(await changeShadcnSetting(root, { setting: 'pointer', enabled: true }), { ok: true, value: { pointer: true, rtl: true } });
    assert.deepEqual(await changeShadcnSetting(root, { setting: 'pointer', enabled: false }), { ok: true, value: { pointer: false, rtl: true } });
    assert.equal(readFileSync(file, 'utf8').trim(), original.trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('turning RTL off updates the starter preview and retains migrated component source', async () => {
  const root = site();
  try {
    writeFileSync(path.join(root, 'components.json'), JSON.stringify(config));
    mkdirSync(path.join(root, 'src/layouts'), { recursive: true });
    mkdirSync(path.join(root, 'src/components/examples'), { recursive: true });
    const layout = path.join(root, 'src/layouts/main.astro');
    const picker = path.join(root, 'src/components/examples/ThemePicker.tsx');
    writeFileSync(layout, shadcnStarterLayout('base', { rtl: true }));
    writeFileSync(picker, shadcnThemePicker('base', { rtl: true }));
    const component = path.join(root, 'src/components/Custom.astro');
    writeFileSync(component, '<button class="ms-4">Project content</button>');
    assert.deepEqual(await changeShadcnSetting(root, { setting: 'rtl', enabled: false }), { ok: true, value: { pointer: false, rtl: false } });
    assert.equal(readFileSync(layout, 'utf8'), shadcnStarterLayout('base', { rtl: false }));
    assert.equal(readFileSync(picker, 'utf8'), shadcnThemePicker('base', { rtl: false }));
    assert.equal(readFileSync(component, 'utf8'), '<button class="ms-4">Project content</button>');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps another library hidden and refuses CSS linked outside the project', async () => {
  const root = site();
  const other = site();
  try {
    const manifest = path.join(root, 'components.json');
    writeFileSync(manifest, JSON.stringify({ ...config, $schema: 'https://example.test/schema.json' }));
    assert.deepEqual(readShadcnSettings(root), { ok: true, value: undefined });
    writeFileSync(manifest, JSON.stringify(config));
    mkdirSync(path.join(root, 'src/styles'), { recursive: true });
    const target = path.join(other, 'global.css');
    writeFileSync(target, ':root {}\n');
    symlinkSync(target, path.join(root, config.tailwind.css));
    assert.equal((await changeShadcnSetting(root, { setting: 'pointer', enabled: true })).ok, false);
    assert.equal(readFileSync(target, 'utf8'), ':root {}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('resolves shadcn config from a declared monorepo workspace UI package and ignores unreferenced or ambiguous ones', async () => {
  const workspace = site();
  try {
    const app = path.join(workspace, 'apps', 'site');
    const ui = path.join(workspace, 'packages', 'ui');
    const unusedUi = path.join(workspace, 'packages', 'unused-ui');
    mkdirSync(path.join(app, 'src'), { recursive: true });
    mkdirSync(path.join(ui, 'src', 'styles'), { recursive: true });
    mkdirSync(path.join(ui, 'src', 'components'), { recursive: true });
    mkdirSync(path.join(unusedUi, 'src', 'styles'), { recursive: true });

    writeFileSync(path.join(workspace, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
    writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: '@mono/site', dependencies: { astro: '^7.0.0', '@mono/ui': 'workspace:*' } }));
    writeFileSync(
      path.join(ui, 'package.json'),
      JSON.stringify({ name: '@mono/ui', exports: { './globals.css': './src/styles/globals.css', './components/*': './src/components/*.tsx' } }),
    );
    writeFileSync(
      path.join(ui, 'components.json'),
      JSON.stringify({
        $schema: 'https://ui.shadcn.com/schema.json',
        style: 'base-sera',
        tailwind: { css: 'src/styles/globals.css' },
        aliases: { ui: '@mono/ui/components' },
        rtl: true,
      }),
    );
    const uiCss = path.join(ui, 'src', 'styles', 'globals.css');
    writeFileSync(uiCss, '@layer base {\n  button:not(:disabled), [role="button"]:not(:disabled) {\n    cursor: pointer;\n  }\n}\n');

    // Unreferenced sibling package must not interfere with the declared dependency match.
    writeFileSync(path.join(unusedUi, 'package.json'), JSON.stringify({ name: '@mono/unused-ui' }));
    writeFileSync(path.join(unusedUi, 'components.json'), JSON.stringify(config));

    assert.deepEqual(readShadcnSettings(app), { ok: true, value: { pointer: true, rtl: true, packagePath: 'packages/ui' } });
    assert.deepEqual(await changeShadcnSetting(app, { setting: 'pointer', enabled: false }), {
      ok: true,
      value: { pointer: false, rtl: true, packagePath: 'packages/ui' },
    });
    assert.deepEqual(await changeShadcnSetting(app, { setting: 'pointer', enabled: true }), {
      ok: true,
      value: { pointer: true, rtl: true, packagePath: 'packages/ui' },
    });

    // If the app depends on two workspace packages that both declare components.json, stay ambiguous (undefined).
    writeFileSync(
      path.join(app, 'package.json'),
      JSON.stringify({ name: '@mono/site', dependencies: { astro: '^7.0.0', '@mono/ui': 'workspace:*', '@mono/unused-ui': 'workspace:*' } }),
    );
    assert.deepEqual(readShadcnSettings(app), { ok: true, value: undefined });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
