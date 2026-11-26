// Exercise the component handoffs through the actual renderer task, AI store, and terminal handler.
// A recording preload and clipboard show where the prompt goes without starting a real provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/componentBuildPrompt.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export * from './src/features/palette/componentBuildPrompt';",
      "export { aiAgentTaskHandler } from './src/features/ai/aiAgentTask';",
      "export { resetAgentChoiceStore } from './src/features/ai/agentChoiceStore';",
      "export { aiState, draftFromText, draftText, loadAiProject, openChat, resetAiStore, setDraft } from './src/features/ai/aiStore';",
      "export { registerAgentTaskHandler } from './src/lib/agentTasks';",
      "export { terminalAgentHandler } from './src/features/terminal/terminalAgent';",
      "export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';",
      "export { AGENT_TASK_LIMITS } from './shared/properties/agentTask';",
    ].join('\n'),
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  logLevel: 'silent',
});
const model = require(output);
const PROJECT = '/site';
const OTHER_PROJECT = '/other-site';
const EXISTING_CHAT = `c${'a'.repeat(24)}`;
const DRAFT_CHAT = `c${'b'.repeat(24)}`;
const summary = (id, agent = 'codex') => ({ id, agent, title: 'New chat', pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false });
const ok = (value) => ({ ok: true, value });

function install(context, options = {}) {
  const calls = [];
  const copied = [];
  const notices = [];
  const storage = new Map([['stacki.ai.agent', 'codex']]);
  const chats = [summary(EXISTING_CHAT, options.existingAgent)];
  const record = (name, reply) => async (payload) => {
    calls.push({ name, payload });
    return reply(payload);
  };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (prompt) => {
        if (options.clipboardError !== undefined) {
          throw options.clipboardError;
        }
        copied.push(prompt);
      },
    },
  });
  global.localStorage = {
    getItem: (key) => storage.get(key) ?? JSON.parse('null'),
    setItem: (key, value) => void storage.set(key, String(value)),
    removeItem: (key) => void storage.delete(key),
  };
  global.window = {
    avb: {
      aiAgents: record(
        'aiAgents',
        options.agents ??
          (() => ({
            trusted: options.trusted ?? true,
            agents: [
              options.unconfigured
                ? { agent: 'codex', state: 'missing-cli' }
                : { agent: 'codex', state: 'ready', adapterVersion: '1.0.0', running: false, downloadMegabytes: 1 },
            ],
            options: [],
          })),
      ),
      aiChats: record('aiChats', ({ projectPath }) => ({ chats: projectPath === PROJECT ? [...chats] : [], sections: [] })),
      aiChatCreate: record('aiChatCreate', async ({ agent }) => {
        await options.beforeCreate?.();
        const created = summary(DRAFT_CHAT, agent);
        chats.unshift(created);
        return ok(created);
      }),
      aiChatRead: record('aiChatRead', ({ chat }) => ok({ summary: chats.find(({ id }) => id === chat), events: [], full: false })),
      aiPrompt: record('aiPrompt', () => ok({ turn: `t${'1'.repeat(16)}` })),
      listAgents: record('listAgents', () => ({ agents: [], paired: [], truncated: false })),
      onAiEvents: () => () => undefined,
      onAiAgentStatus: () => () => undefined,
      onAiSetup: () => () => undefined,
      onInstructionsChanged: () => () => undefined,
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const notify = (message, kind) => notices.push({ message, kind });
  context.after(() => {
    model.resetAgentChoiceStore();
    model.resetAiStore();
    delete navigator.clipboard;
    delete global.localStorage;
    delete global.window;
  });
  return {
    calls,
    copied,
    notices,
    request: () => model.requestBuildComponent(model.ENGLISH_TRANSLATE, notify),
    copy: () => model.copyBuildComponent(model.ENGLISH_TRANSLATE, notify),
  };
}

function registerDesktop(context, options = {}) {
  const opened = [];
  context.after(
    model.registerAgentTaskHandler(
      'ai-panel',
      20,
      model.aiAgentTaskHandler({
        projectPath: options.projectPath ?? (() => PROJECT),
        available: options.available ?? (() => true),
        openPanel: () => opened.push('ai'),
      }),
    ),
  );
  context.after(
    model.registerAgentTaskHandler(
      'terminal',
      10,
      model.terminalAgentHandler({ platform: 'darwin', available: () => true, openDock: () => opened.push('terminal'), mode: () => 'codex' }),
    ),
  );
  return opened;
}

test('the prompt fits the handoff and gives the agent bounded project setup, component, and verification instructions', () => {
  const prompt = model.componentBuildPrompt();
  assert.ok(prompt.length > 0);
  assert.ok(prompt.length <= model.AGENT_TASK_LIMITS.promptCharsMax);
  for (const requirement of [
    'package manager',
    'React and React DOM 19',
    '@ui-sdk/core@0.1.0-beta.17',
    '@ui-sdk/react@0.1.0-beta.17',
    'Ask for explicit approval and wait before installing',
    'typed string label prop and a named body slot',
    'one hydrated React island',
    'no runtime bridge, WebMCP',
    '.stacki/components.json',
    'astro-studio check-project <project-directory>',
    'meaningful static page copy',
    'canonical URL',
    'production build',
    "project's GitHub checks",
    'Avoid global installs',
    'focus return',
    'save, undo, redo, and reopen',
  ]) {
    assert.ok(prompt.includes(requirement), requirement);
  }
});

test('Desktop opens an unsent editable draft and preserves existing words and attachments', async (context) => {
  const fake = install(context);
  const opened = registerDesktop(context);
  await model.loadAiProject(PROJECT);
  await model.openChat(EXISTING_CHAT);
  const draft = {
    ...model.draftFromText('Keep this draft'),
    attachments: [{ id: 'existing', attachment: { kind: 'file', path: 'notes.md' }, preview: undefined }],
  };
  model.setDraft(EXISTING_CHAT, () => draft);

  await fake.request();

  assert.deepEqual(opened, ['ai']);
  assert.deepEqual(fake.copied, []);
  assert.deepEqual(
    fake.calls.filter(({ name }) => name === 'aiChatCreate').map(({ payload }) => payload),
    [{ projectPath: PROJECT, agent: 'codex' }],
  );
  assert.equal(model.aiState().open, DRAFT_CHAT);
  assert.deepEqual(model.aiState().drafts.get(DRAFT_CHAT), model.draftFromText(model.componentBuildPrompt()));
  assert.deepEqual(model.aiState().drafts.get(EXISTING_CHAT), draft);
  assert.equal(
    fake.calls.some(({ name }) => name === 'aiPrompt'),
    false,
  );
  assert.deepEqual(fake.notices, [{ message: model.ENGLISH_TRANSLATE('palette.components.buildWithAI.draftReady'), kind: 'success' }]);
});

test('Desktop opens the draft with the preferred provider when the empty chat belongs to another provider', async (context) => {
  const fake = install(context, { existingAgent: 'claude' });
  const opened = registerDesktop(context);
  await model.loadAiProject(PROJECT);
  await model.openChat(EXISTING_CHAT);

  await fake.request();

  assert.deepEqual(opened, ['ai']);
  assert.equal(model.aiState().open, DRAFT_CHAT);
  assert.equal(model.aiState().chats.find(({ id }) => id === DRAFT_CHAT)?.agent, 'codex');
  assert.equal(model.aiState().drafts.has(EXISTING_CHAT), false);
  assert.equal(fake.calls.filter(({ name }) => name === 'aiPrompt').length, 0);
});

test('an untrusted project or missing provider still only gets an unsent draft', async (context) => {
  const fake = install(context, { trusted: false, unconfigured: true });
  const opened = registerDesktop(context);
  await fake.request();
  assert.deepEqual(opened, ['ai']);
  assert.equal(model.aiState().trusted, false);
  assert.equal(model.draftText(model.aiState().drafts.get(DRAFT_CHAT)), model.componentBuildPrompt());
  assert.equal(
    fake.calls.some(({ name }) => name === 'aiPrompt'),
    false,
  );
});

test('Desktop falls back to the clipboard when the role changes during loading', async (context) => {
  const agents = Promise.withResolvers();
  const fake = install(context, { agents: () => agents.promise });
  let available = true;
  const opened = registerDesktop(context, { available: () => available });
  const request = fake.request();
  available = false;
  agents.resolve({ trusted: true, agents: [], options: [] });
  await request;
  assert.deepEqual(opened, []);
  assert.deepEqual(fake.copied, [model.componentBuildPrompt()]);
  assert.deepEqual(
    fake.calls.map(({ name }) => name),
    ['aiAgents', 'aiChats'],
  );
});

test('a chat creation reply cannot place the draft after a project switch, even after returning to the same path', async (context) => {
  const started = Promise.withResolvers();
  const created = Promise.withResolvers();
  const fake = install(context, {
    beforeCreate: async () => {
      started.resolve();
      await created.promise;
    },
  });
  const opened = registerDesktop(context);
  const request = fake.request();
  await started.promise;
  await model.loadAiProject(OTHER_PROJECT);
  await model.loadAiProject(PROJECT);
  await model.openChat(EXISTING_CHAT);
  const existing = model.draftFromText('Draft from the current project visit');
  model.setDraft(EXISTING_CHAT, () => existing);
  created.resolve();
  await request;

  assert.equal(model.aiState().open, EXISTING_CHAT);
  assert.deepEqual([...model.aiState().drafts], [[EXISTING_CHAT, existing]]);
  assert.deepEqual(
    model.aiState().chats.map(({ id }) => id),
    [EXISTING_CHAT],
  );
  assert.deepEqual(opened, []);
  assert.deepEqual(fake.copied, [model.componentBuildPrompt()]);
});

test('Studio copies the same prompt without dispatching to a registered chat handler', async (context) => {
  const fake = install(context);
  let dispatched = 0;
  context.after(
    model.registerAgentTaskHandler('studio-chat', 20, async () => {
      dispatched += 1;
      return { tag: 'sent', where: 'Studio chat' };
    }),
  );

  await fake.copy();

  assert.equal(dispatched, 0);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(fake.copied, [model.componentBuildPrompt()]);
  assert.deepEqual(fake.notices, [{ message: model.ENGLISH_TRANSLATE('ui.handoff.copied'), kind: 'success' }]);
});

test('a clipboard rejection reports an error without opening either handler path', async (context) => {
  const reason = 'Document is not focused';
  const fake = install(context, { clipboardError: new Error(reason) });
  const opened = registerDesktop(context, { available: () => false });

  await fake.request();
  await fake.copy();

  assert.deepEqual(opened, []);
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(fake.copied, []);
  const message = model.ENGLISH_TRANSLATE('ui.handoff.failed', { reason });
  assert.deepEqual(fake.notices, [
    { message, kind: 'error' },
    { message, kind: 'error' },
  ]);
});
