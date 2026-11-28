// Goal: Welcome opens Astro projects and monorepo apps directly, and Review setup inside the project supports
// witnessed folder saves, toast-backed prompt copying, and closing on Send to AI.
// Method: bundle WelcomeScreen, ProjectSetupDialog, and registerAgentTaskHandler in jsdom and drive the real controls.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');
const { installPopupDOM } = require('../../helpers/popupDom');

const projectPath = '/projects/astro-site';
const firstRevision = 'a'.repeat(64);
const freshRevision = 'b'.repeat(64);
const report = {
  revision: firstRevision,
  pagesFolder: 'src/pages',
  pagesSource: 'default',
  desktopPages: 1,
  studioPages: 2,
  incomplete: false,
  settings: 'editable',
  packageManager: 'pnpm',
  dependenciesInstalled: false,
  findings: [
    {
      code: 'dependencies-missing',
      severity: 'blocker',
      summary: 'Astro dependencies are not installed.',
      action: 'Run pnpm install before starting preview.',
      files: ['package.json'],
    },
  ],
  suggestions: [
    {
      kind: 'components',
      folders: ['src/components', 'src/ui'],
      desktopBefore: 0,
      desktopAfter: 1,
      studioBefore: 3,
      studioAfter: 1,
      desktopAdded: ['src/ui/Card.astro'],
      studioAdded: [],
      studioRemoved: ['src/shells/Frame.astro', 'public/Legacy.astro'],
    },
    {
      kind: 'layouts',
      folders: ['src/layouts', 'src/shells'],
      desktopBefore: 0,
      desktopAfter: 1,
      studioBefore: 3,
      studioAfter: 1,
      desktopAdded: ['src/shells/Frame.astro'],
      studioAdded: [],
      studioRemoved: ['src/ui/Card.astro', 'public/Legacy.astro'],
    },
  ],
};

test('Welcome opens Astro projects directly and Review setup handles stale saves, toast prompt copy, and closing on Send to AI', async (context) => {
  const output = repoPath('node_modules/.stacki-test/project-setup.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await esbuild.build({
    stdin: {
      contents: `
export { default as WelcomeScreen } from './src/features/welcome/WelcomeScreen';
export { ProjectSetupDialog } from './src/features/projectSetup/ProjectSetupDialog';
export { registerAgentTaskHandler } from './src/lib/agentTasks';`,
      resolveDir: repoPath('.'),
    },
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty' },
    logLevel: 'silent',
  });

  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  installPopupDOM(dom.window);
  global.window = dom.window;
  global.document = dom.window.document;
  global.Node = dom.window.Node;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLCanvasElement.prototype.getContext = () => JSON.parse('null');
  global.WebGLRenderingContext = dom.window.WebGLRenderingContext = function WebGLRenderingContext() {};
  const { createElement, act } = require('react');
  const { createRoot } = require('react-dom/client');
  const { WelcomeScreen, ProjectSetupDialog, registerAgentTaskHandler } = require(output);
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });

  const open = [];
  const openWithSetup = [];
  const scans = [];
  const writes = [];
  const copied = [];
  const toasts = [];
  const sentTasks = [];
  let replyToScan;
  const previousClipboard = Object.getOwnPropertyDescriptor(global.navigator, 'clipboard');
  Object.defineProperty(global.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value) => {
        copied.push(value);
      },
    },
  });
  context.after(() => {
    if (previousClipboard === undefined) {
      delete global.navigator.clipboard;
    } else {
      Object.defineProperty(global.navigator, 'clipboard', previousClipboard);
    }
  });
  const unregisterAgent = registerAgentTaskHandler('ai-panel', 100, async (task) => {
    sentTasks.push(task);
    return { tag: 'sent', where: 'Codex in the AI panel' };
  });
  context.after(unregisterAgent);

  window.avb = {
    listRecents: async () => [],
    takeOpenedFolders: async () => [],
    onFolderOpened: () => () => {},
    openSiteDialog: async () => ({ kind: 'astro', projectPath }),
    scanProjectSetup: (request) => {
      scans.push(request);
      return new Promise((resolve) => {
        replyToScan = resolve;
      });
    },
    applyProjectSetup: async (request) => {
      writes.push(request);
      return writes.length === 1
        ? { ok: false, error: { code: 'stale', message: 'Review again.' } }
        : { ok: true, value: { ...report, revision: 'c'.repeat(64), suggestions: [] } };
    },
  };

  const dialog = () => document.querySelector('dialog[open]');
  const control = (name, scope = dialog()) => {
    const button = [...scope.querySelectorAll('button')].find((item) => item.textContent.trim() === name);
    assert.ok(button, `Expected a ${name} button`);
    return button;
  };
  const click = (button) => act(async () => button.click());
  const resolveScan = (result) => act(async () => replyToScan(result));
  const selected = () => [...dialog().querySelectorAll('input:checked')].map((item) => item.parentElement.textContent.trim());
  const save = () => control('Save selected folders');
  const checkboxes = () => [...dialog().querySelectorAll('input[type="checkbox"]')];
  const welcome = () => control('Open from folder', document);

  // Welcome opens single Astro projects directly with setup review instead of showing the full setup modal on Welcome.
  await act(async () =>
    root.render(
      createElement(WelcomeScreen, {
        onOpen: (directory) => open.push(directory),
        onOpenWithSetup: (directory) => openWithSetup.push(directory),
        showToast: (message, kind) => toasts.push({ message, kind }),
      }),
    ),
  );
  await click(welcome());
  assert.equal(Boolean(dialog()), false);
  assert.deepEqual(openWithSetup, [projectPath]);
  assert.deepEqual(open, []);

  // Multi-app monorepo shows the compact workspace app chooser before opening.
  const webAppPath = '/projects/mono/apps/web';
  const docsAppPath = '/projects/mono/apps/docs';
  window.avb.openSiteDialog = async () => ({
    kind: 'workspace',
    workspaceRoot: '/projects/mono',
    apps: [
      { name: 'web', relativePath: 'apps/web', projectPath: webAppPath },
      { name: 'docs', relativePath: 'apps/docs', projectPath: docsAppPath },
    ],
  });
  await click(welcome());
  assert.equal(dialog().getAttribute('aria-label'), 'Workspace app');
  await click(control('Continue to editor'));
  assert.equal(openWithSetup.at(-1), webAppPath);

  // Inside the project: Review setup scans, copies via toast (not raw inline text), handles stale saves, and closes on Send to AI.
  let closed = 0;
  let promptSent = 0;
  let savedCount = 0;
  await act(async () =>
    root.render(
      createElement(ProjectSetupDialog, {
        projectPath,
        mode: 'settings',
        showToast: (message, kind) => toasts.push({ message, kind }),
        onClose: () => {
          closed += 1;
        },
        onPromptSent: () => {
          promptSent += 1;
        },
        onSaved: () => {
          savedCount += 1;
        },
      }),
    ),
  );
  assert.equal(dialog().getAttribute('aria-label'), 'Review setup');
  assert.deepEqual(scans, [{ projectPath }]);
  assert.match(dialog().querySelector('[role="status"]').textContent, /Checking project files/);

  await resolveScan({ ok: true, value: report });
  assert.match(dialog().textContent, /Desktop pages: 1\. Studio pages: 2\./);
  assert.match(dialog().textContent, /Compatibility report/);
  assert.match(dialog().textContent, /Astro dependencies are not installed\./);
  assert.match(dialog().textContent, /\+ src\/ui\/Card\.astro/);
  assert.match(dialog().textContent, /− public\/Legacy\.astro/);

  // Copy prompt uses toast feedback rather than pushing plain status text into the modal body.
  await click(control('Copy prompt'));
  assert.equal(copied.length, 1);
  assert.match(copied[0], /\[Blocker\] Astro dependencies are not installed\./);
  assert.equal(toasts.at(-1).kind, 'success');
  assert.match(toasts.at(-1).message, /Setup prompt copied\./);
  assert.equal(Boolean(dialog().querySelector('[role="status"]')), false);

  // Stale save forces a fresh scan and clears prior selections.
  assert.deepEqual(selected(), []);
  assert.equal(save().disabled, true);
  await click(checkboxes()[0]);
  assert.deepEqual(selected(), ['Components']);
  await click(save());
  assert.deepEqual(writes, [{ projectPath, revision: firstRevision, kinds: ['components'] }]);
  assert.deepEqual(scans, [{ projectPath }, { projectPath }]);
  assert.match(dialog().textContent, /project changed during review/);

  await resolveScan({ ok: true, value: { ...report, revision: freshRevision } });
  assert.deepEqual(selected(), []);
  assert.equal(save().disabled, true);
  await click(checkboxes()[1]);
  await click(save());
  assert.deepEqual(writes[1], { projectPath, revision: freshRevision, kinds: ['layouts'] });
  assert.equal(savedCount, 1);
  assert.match(dialog().querySelector('[role="status"]').textContent, /Folder settings saved/);

  // Send to AI dispatches to the registered agent, shows a toast, and closes the modal (plus parent Settings via onPromptSent).
  await act(async () =>
    root.render(
      createElement(ProjectSetupDialog, {
        key: 'send-to-ai',
        projectPath,
        mode: 'settings',
        showToast: (message, kind) => toasts.push({ message, kind }),
        onClose: () => {
          closed += 1;
        },
        onPromptSent: () => {
          promptSent += 1;
        },
        onSaved: assert.fail,
      }),
    ),
  );
  await resolveScan({ ok: true, value: { ...report, suggestions: [] } });
  await click(control('Send to AI'));
  assert.equal(sentTasks.length, 1);
  assert.equal(toasts.at(-1).kind, 'success');
  assert.match(toasts.at(-1).message, /Setup prompt sent to Codex in the AI panel\./);
  assert.equal(closed, 1);
  assert.equal(promptSent, 1);

  // Settings native folder confirmation flow when unauthorized.
  await act(async () =>
    root.render(
      createElement(ProjectSetupDialog, {
        key: 'confirm',
        projectPath,
        mode: 'settings',
        onClose: assert.fail,
        onSaved: assert.fail,
      }),
    ),
  );
  await resolveScan({ ok: false, error: { code: 'unauthorized', message: 'Permission denied.' } });
  assert.match(dialog().querySelector('[role="alert"]').textContent, /Choose the open project folder/);
  await click(control('Choose…'));
  assert.deepEqual(scans.at(-1), { projectPath, permission: 'confirm-open' });
  await resolveScan({ ok: true, value: report });
  assert.deepEqual(selected(), []);
  assert.equal(save().disabled, true);
});
