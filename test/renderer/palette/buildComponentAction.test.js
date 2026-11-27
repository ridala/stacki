// Goal: the Components header offers the handoff with no page selection and respects project and role changes.
// Method: mount the real panel and popup, change the host and effective role, and record each confirmed callback.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { installPopupDOM } = require('../../helpers/popupDom');
const { repoPath } = require('../../helpers/sources.js');

test('component builder confirms only for the current project and role', async () => {
  const directory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'build-component-action.cjs');
  buildSync({
    stdin: {
      contents: [
        "export { default as PalettePanel } from './src/features/palette/PalettePanel';",
        "export { setActualRole } from './src/lib/currentRole';",
        "export { CLIENT_ROLE_ID, DEFAULT_PROJECT_ROLES, roleViewOf } from './shared/properties/projectRoles';",
      ].join('\n'),
      resolveDir: repoPath('.'),
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'empty' },
    logLevel: 'silent',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  });
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost', pretendToBeVisual: true });
  installPopupDOM(dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { PalettePanel, setActualRole, CLIENT_ROLE_ID, DEFAULT_PROJECT_ROLES, roleViewOf } = require(output);
  const root = createRoot(document.getElementById('root'));
  const calls = [];

  const render = (projectKey, destination) =>
    act(async () => {
      root.render(
        React.createElement(PalettePanel, {
          components: [],
          trailingSlash: 'ignore',
          devUrl: undefined,
          createFrom: { kind: 'unavailable', reason: 'Select an element.' },
          onInsert() {},
          onCreateComponent() {},
          buildComponent: {
            projectKey,
            destination,
            async run() {
              calls.push({ projectKey, destination });
            },
          },
        }),
      );
    });
  const build = () => document.querySelector('button[aria-label="Build a component with AI"]') ?? undefined;
  const dialog = () => document.querySelector('dialog[open]') ?? undefined;
  const click = (button) => act(async () => button.click());

  try {
    await render('project-one', 'chat');
    assert.equal(document.querySelector('button[aria-label="New component"]').disabled, true);
    build().focus();
    await click(build());
    assert.equal(dialog().getAttribute('aria-label'), 'Build a component with AI');
    assert.match(dialog().textContent, /React 19/);
    assert.equal(document.activeElement.textContent, 'Cancel');
    assert.deepEqual(calls, []);

    await act(async () => dialog().dispatchEvent(new dom.window.Event('cancel', { cancelable: true })));
    assert.equal(dialog(), undefined);
    assert.equal(document.activeElement, build());
    assert.deepEqual(calls, []);

    await click(build());
    const openDraft = dialog().querySelector('button.primary');
    assert.equal(openDraft.textContent, 'Open AI draft');
    await click(openDraft);
    assert.deepEqual(calls, [{ projectKey: 'project-one', destination: 'chat' }]);

    await click(build());
    const staleConfirm = dialog().querySelector('button.primary');
    await render('project-two', 'clipboard');
    assert.equal(dialog(), undefined);
    await click(staleConfirm);
    assert.equal(calls.length, 1);

    await click(build());
    const copyTask = dialog().querySelector('button.primary');
    assert.equal(copyTask.textContent, 'Copy task');
    await click(copyTask);
    assert.deepEqual(calls, [
      { projectKey: 'project-one', destination: 'chat' },
      { projectKey: 'project-two', destination: 'clipboard' },
    ]);

    await click(build());
    await act(async () => setActualRole(roleViewOf(DEFAULT_PROJECT_ROLES, CLIENT_ROLE_ID)));
    assert.equal(dialog(), undefined);
    assert.equal(build(), undefined);
    assert.equal(calls.length, 2);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
