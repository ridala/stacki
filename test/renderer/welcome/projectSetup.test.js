// Goal: a native Astro selection stays in review until the user saves or opens the editor.
// Method: bundle the Welcome screen and setup dialog in jsdom and drive the real controls against a scripted preload bridge.
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

test('Welcome scans before opening, requires a fresh selection after stale, and waits for Continue after save or skip', async (context) => {
  const output = repoPath('node_modules/.stacki-test/project-setup.cjs');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await esbuild.build({
    stdin: {
      contents: `
export { default as WelcomeScreen } from './src/features/welcome/WelcomeScreen';
export { ProjectSetupDialog } from './src/features/projectSetup/ProjectSetupDialog';`,
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
  const { WelcomeScreen, ProjectSetupDialog } = require(output);
  const root = createRoot(document.getElementById('root'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });

  const open = [];
  const scans = [];
  const writes = [];
  let replyToScan;
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

  await act(async () =>
    root.render(
      createElement(WelcomeScreen, {
        onOpen: (directory) => open.push(directory),
        showToast: assert.fail,
        renderSetupDialog: (setup) => createElement(ProjectSetupDialog, { mode: 'welcome', ...setup }),
      }),
    ),
  );
  welcome().focus();
  await click(welcome());
  assert.equal(dialog().getAttribute('aria-label'), 'Review setup');
  assert.deepEqual(scans, [{ projectPath }]);
  assert.match(dialog().querySelector('[role="status"]').textContent, /Checking project files/);
  assert.deepEqual(open, []);

  await resolveScan({ ok: true, value: report });
  assert.match(dialog().textContent, /Desktop pages: 1\. Studio pages: 2\./);
  assert.match(dialog().textContent, /\+ src\/ui\/Card\.astro/);
  assert.match(dialog().textContent, /− public\/Legacy\.astro/);
  assert.deepEqual(selected(), []);
  assert.equal(save().disabled, true);
  await click(checkboxes()[0]);
  assert.deepEqual(selected(), ['Components']);
  assert.deepEqual(writes, []);
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
  assert.match(dialog().querySelector('[role="status"]').textContent, /Folder settings saved/);
  assert.deepEqual(open, []);
  assert.equal(document.activeElement, control('Continue to editor'));
  await click(control('Continue to editor'));
  assert.deepEqual(open, [projectPath]);

  welcome().focus();
  await click(welcome());
  await resolveScan({ ok: true, value: report });
  await click(checkboxes()[0]);
  await click(control('Cancel'));
  assert.equal(Boolean(dialog()), false);
  assert.equal(document.activeElement, welcome());
  assert.deepEqual(open, [projectPath]);
  assert.equal(writes.length, 2);

  await click(welcome());
  await resolveScan({ ok: true, value: report });
  await click(control('Skip setup'));
  assert.deepEqual(open, [projectPath]);
  assert.equal(writes.length, 2);
  assert.equal(document.activeElement, control('Continue to editor'));
  await click(control('Continue to editor'));
  assert.deepEqual(open, [projectPath, projectPath]);
  assert.equal(writes.length, 2);

  await act(async () => root.render(createElement(ProjectSetupDialog, { projectPath, mode: 'settings', onClose: assert.fail, onSaved: assert.fail })));
  await resolveScan({ ok: false, error: { code: 'unauthorized', message: 'Permission denied.' } });
  assert.match(dialog().querySelector('[role="alert"]').textContent, /Choose the open project folder/);
  await click(control('Choose…'));
  assert.deepEqual(scans.at(-1), { projectPath, permission: 'confirm-open' });
  await resolveScan({ ok: true, value: report });
  assert.deepEqual(selected(), []);
  assert.equal(save().disabled, true);
});
