// Verifies discovery of local and workspace React/Vue/Svelte components and safe on-demand `.astro` wrapper creation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverFrameworkComponents, wrapFrameworkComponent } from '#dist/electron/project/frameworkComponents.js';

function writeFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

test('discovers local and workspace framework components while skipping tests, hooks, and non-JSX helpers', (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-framework-components-'));
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  writeFiles(workspace, {
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
    'package.json': JSON.stringify({ name: 'mono', private: true }),
    'packages/ui/package.json': JSON.stringify({
      name: '@demo/ui',
      exports: {
        './components/*': './src/components/*.tsx',
      },
    }),
    'packages/ui/src/components/button.tsx': 'export function Button() { return <button>Click</button>; }\n',
    'packages/ui/src/components/helper.tsx': 'export const formatPrice = (n: number) => `${n}`;\n',
    'apps/site/package.json': JSON.stringify({
      name: '@demo/site',
      dependencies: { '@demo/ui': 'workspace:*', astro: '^5.0.0' },
    }),
    'apps/site/src/components/FeedbackForm.tsx': 'export default function FeedbackForm() { return <form><button>Send</button></form>; }\n',
    'apps/site/src/components/PricingCard.vue': '<template><div>Pricing</div></template>\n',
    'apps/site/src/components/Newsletter.svelte': '<form><input /></form>\n',
    'apps/site/src/components/AlreadyWrapped.tsx': 'export default function AlreadyWrapped() { return <div />; }\n',
    'apps/site/src/components/FeedbackForm.test.tsx': 'export default function Test() { return <div />; }\n',
    'apps/site/src/components/useToggle.tsx': 'export function useToggle() { return <div />; }\n',
  });

  const appRoot = path.join(workspace, 'apps/site');
  const existingAstro = new Set(['alreadywrapped']);
  const found = discoverFrameworkComponents(appRoot, ['src/components'], existingAstro);
  assert.deepEqual(
    found.map((entry) => ({
      name: entry.name,
      importPath: entry.importPath,
      exportKind: entry.exportKind,
      framework: entry.framework,
      packageName: entry.packageName,
      wrapped: entry.wrapped,
    })),
    [
      {
        name: 'AlreadyWrapped',
        importPath: './AlreadyWrapped',
        exportKind: 'default',
        framework: 'react',
        packageName: undefined,
        wrapped: true,
      },
      {
        name: 'Button',
        importPath: '@demo/ui/components/button',
        exportKind: 'named',
        framework: 'react',
        packageName: '@demo/ui',
        wrapped: undefined,
      },
      {
        name: 'FeedbackForm',
        importPath: './FeedbackForm',
        exportKind: 'default',
        framework: 'react',
        packageName: undefined,
        wrapped: undefined,
      },
      {
        name: 'Newsletter',
        importPath: './Newsletter.svelte',
        exportKind: 'default',
        framework: 'svelte',
        packageName: undefined,
        wrapped: undefined,
      },
      {
        name: 'PricingCard',
        importPath: './PricingCard.vue',
        exportKind: 'default',
        framework: 'vue',
        packageName: undefined,
        wrapped: undefined,
      },
    ],
  );
});

test('wraps a framework component into an .astro file safely and never overwrites existing files', (context) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-wrap-component-'));
  context.after(() => fs.rmSync(project, { recursive: true, force: true }));
  writeFiles(project, {
    'src/components/FeedbackForm.tsx': 'export default function FeedbackForm() { return <form />; }\n',
  });

  const created = wrapFrameworkComponent({
    projectPath: project,
    name: 'FeedbackForm',
    importPath: './FeedbackForm',
    exportKind: 'default',
    framework: 'react',
  });
  assert.equal(created.ok, true);
  if (!created.ok) {
    return;
  }
  assert.equal(created.value.rel, 'src/components/FeedbackForm.astro');
  const content = fs.readFileSync(created.value.path, 'utf8');
  assert.match(content, /import FeedbackForm from '\.\/FeedbackForm';/);
  assert.match(content, /<FeedbackForm client:load class=\{className\} \/>/);

  // Second wrap refuses to overwrite the existing wrapper.
  const duplicate = wrapFrameworkComponent({
    projectPath: project,
    name: 'FeedbackForm',
    importPath: './FeedbackForm',
    exportKind: 'default',
    framework: 'react',
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    assert.equal(duplicate.error.code, 'exists');
  }

  // Named export from workspace package works cleanly.
  const named = wrapFrameworkComponent({
    projectPath: project,
    name: 'Button',
    importPath: '@demo/ui/components/button',
    exportKind: 'named',
    framework: 'react',
  });
  assert.equal(named.ok, true);
  if (named.ok) {
    assert.match(fs.readFileSync(named.value.path, 'utf8'), /import \{ Button \} from '@demo\/ui\/components\/button';/);
  }

  // Unsafe names and specifiers are rejected.
  const badName = wrapFrameworkComponent({
    projectPath: project,
    name: '../Escape',
    importPath: './Escape',
    exportKind: 'default',
    framework: 'react',
  });
  assert.equal(badName.ok, false);
  const badImport = wrapFrameworkComponent({
    projectPath: project,
    name: 'SafeName',
    importPath: "./bad'; alert(1); '",
    exportKind: 'default',
    framework: 'react',
  });
  assert.equal(badImport.ok, false);
});
