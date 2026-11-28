// Handing work to the coding agent built into Stacki. Any panel asks with
// `requestAgentTask(task)`; handlers registered here answer, highest priority
// first, and the first that takes the task wins. Today the terminal dock's agent
// (Claude Code or Codex, src/features/terminal/terminalAgent.ts) registers one;
// the AI panel, when it lands, registers its own at a higher priority and every
// caller reaches it without a change. With no handler willing, the prompt goes
// to the clipboard, so a hand-off never silently does nothing.
import { assert } from '../../shared/core/assert';
import { agentTask, type AgentTask } from '../../shared/properties/agentTask';
import type { Translator } from '../../shared/properties/i18n/messageRef';
import type { ShadcnLintStatus } from '../../shared/properties/mcp';
import type { ScanFrameworkComponent } from '../../shared/properties/projectScan';

/** How a hand-off ended, for the caller's toast. */
export type AgentTaskOutcome =
  /** A handler took it: `where` names it for the toast ("the terminal’s Claude Code"). */
  | { readonly tag: 'sent'; readonly where: string }
  /** No handler took it and the prompt is on the clipboard. */
  | { readonly tag: 'copied' }
  /** Nothing could take it, the clipboard included. */
  | { readonly tag: 'failed'; readonly message: string };

/** A handler answers `declined` when it cannot take this task now (no agent configured, no access). */
export type AgentTaskHandler = (task: AgentTask) => Promise<{ readonly tag: 'sent'; readonly where: string } | { readonly tag: 'declined' }>;

interface Registration {
  readonly name: string;
  /** Higher runs first: the AI panel above the terminal. */
  readonly priority: number;
  readonly handle: AgentTaskHandler;
}

const HANDLERS_MAX = 16;
const handlers: Registration[] = [];

/** Registers `handle` under `name`, replacing an earlier one of that name; returns the unregister. */
export function registerAgentTaskHandler(name: string, priority: number, handle: AgentTaskHandler): () => void {
  assert(name.length > 0, 'registerAgentTaskHandler: a handler has a name');
  assert(Number.isFinite(priority), 'registerAgentTaskHandler: a priority is a number');
  const existing = handlers.findIndex((entry) => entry.name === name);
  if (existing !== -1) {
    handlers.splice(existing, 1);
  }
  assert(handlers.length < HANDLERS_MAX, 'registerAgentTaskHandler: handlers are bounded');
  const registration: Registration = { name, priority, handle };
  handlers.push(registration);
  handlers.sort((left, right) => right.priority - left.priority);
  return () => {
    const index = handlers.indexOf(registration);
    if (index !== -1) {
      handlers.splice(index, 1);
    }
  };
}

/** The registered handler names, highest priority first. */
export function agentTaskHandlerNames(): readonly string[] {
  return handlers.map((entry) => entry.name);
}

/** Hands `task` to the first handler that takes it, or copies its prompt. */
export async function requestAgentTask(task: AgentTask): Promise<AgentTaskOutcome> {
  const checked = agentTask(task);
  for (const registration of [...handlers]) {
    let answer: Awaited<ReturnType<AgentTaskHandler>>;
    try {
      answer = await registration.handle(checked);
    } catch {
      continue; // A failing handler is passed over; the next one, or the clipboard, still takes the task.
    }
    if (answer.tag === 'sent') {
      return answer;
    }
  }
  return copyAgentPrompt(checked.prompt);
}

/** Copies an agent prompt without dispatching to the host's registered handlers. */
export async function copyAgentPrompt(prompt: string): Promise<Exclude<AgentTaskOutcome, { readonly tag: 'sent' }>> {
  try {
    await navigator.clipboard.writeText(prompt);
    return { tag: 'copied' };
  } catch (error: unknown) {
    return { tag: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** The toast a hand-off ends with. */
export function agentTaskMessage(outcome: AgentTaskOutcome, translate: Translator): { readonly message: string; readonly kind: 'success' | 'info' | 'error' } {
  switch (outcome.tag) {
    case 'sent':
      return { message: translate('ui.handoff.sent', { where: outcome.where }), kind: 'success' };
    case 'copied':
      return { message: translate('ui.handoff.copied'), kind: 'info' };
    case 'failed':
      return { message: translate('ui.handoff.failed', { reason: outcome.message }), kind: 'error' };
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

type BuildNotify = (message: string, kind: 'success' | 'error') => void;

export function componentBuildPrompt(): string {
  return `Build one accessible Dialog for this Astro project using Vercel UI SDK. Make it insertable and editable in Stacki.

1. Read the project instructions, manifest, lockfile, Astro config, component root, existing shadcn setup, and installed SDK docs. Use the project's package manager and reuse compatible setup. Match the Astro React integration to the project's Astro version. Use React and React DOM 19 with React types 19.2.10 or later. Use exact project-local pins @ui-sdk/react@0.1.0-beta.17 and @ui-sdk/core@0.1.0-beta.17. Import the Dialog parts from @ui-sdk/react/dialog.
2. Before changing setup, show the project-local commands, dependency and lockfile changes, and any Astro config changes. Explain the dependencies, license, and transitive cost. Ask for explicit approval and wait before installing or changing setup. If the package manager is ambiguous, React is missing or incompatible, or project policy blocks the pins, explain the options first. Avoid global installs, shell-wide setup, and elevated permissions. Keep Stacki's editor dependencies, the starter, and the existing shadcn setup intact. The Dialog needs no runtime bridge, WebMCP, or extra preview tooling.
3. Show the proposed files and recipe changes before writing. Create an ordinary .astro wrapper under the project's component root. Expose a typed string label prop and a named body slot. Pass both to one hydrated React island containing the Dialog trigger, title, content, and close button. Use server rendering for the trigger and keep meaningful static page copy, headings, and real links outside the closed Dialog. Preserve the layout, title, description, canonical URL, Open Graph, JSON-LD, robots, sitemap, site and base settings, and route statuses. Scope component CSS and reuse project styling tokens.
4. Add a bounded insertion recipe to .stacki/components.json keyed by the wrapper's project-relative path. Seed label and use an element child with a slot prop set to body. Keep existing recipe entries and instances intact. Use ordinary Astro props and slots in source files.
5. In the project's GitHub checks, run astro-studio check-project <project-directory> and the project's Astro check and production build. Fix missing files, invalid slots, and recipe cycles. Compare raw HTML and hydrated DOM for static content, SEO tags, and hydration warnings. In Stacki, verify discovery, insertion, editing props and slot content, save, undo, redo, and reopen. In interactive preview, check the Dialog's accessible name, focus on open, Tab containment, Escape, and focus return. Report the versions, file and dependency diffs, and anything you could not verify.`;
}

export async function requestBuildComponent(translate: Translator, notify: BuildNotify): Promise<void> {
  const outcome = await requestAgentTask(
    agentTask({
      title: translate('palette.components.buildWithAI'),
      prompt: componentBuildPrompt(),
      delivery: 'draft',
      context: { files: [], nodeRefs: [], findingIds: [] },
    }),
  );
  if (outcome.tag === 'sent') {
    // The AI handler took the draft. Its generic outcome would say the prompt was sent.
    notify(translate('palette.components.buildWithAI.draftReady'), 'success');
    return;
  }
  const { message, kind } = agentTaskMessage(outcome, translate);
  notify(message, kind === 'error' ? 'error' : 'success');
}

export async function copyBuildComponent(translate: Translator, notify: BuildNotify): Promise<void> {
  // Studio's own handler writes to chat. Copy directly to keep that state untouched.
  const { message, kind } = agentTaskMessage(await copyAgentPrompt(componentBuildPrompt()), translate);
  notify(message, kind === 'error' ? 'error' : 'success');
}

export function wrapFrameworkComponentPrompt(component: ScanFrameworkComponent): string {
  const importStatement =
    component.exportKind === 'named'
      ? `import { ${component.name} } from '${component.importPath}';`
      : `import ${component.name} from '${component.importPath}';`;
  return [
    `Wrap the existing ${component.framework} component "${component.name}" (${component.file}) as an Astro component so it can be inserted and edited visually in Stacki.`,
    '',
    `1. Inspect ${component.file} to see its props, defaults, and children/slots.`,
    `2. Create a clean wrapper at src/components/${component.name}.astro using \`${importStatement}\` and an appropriate Astro hydration directive (such as \`client:load\` or \`client:visible\`) only if it needs client interactivity.`,
    `3. Expose the useful visual props on \`export interface Props\` with sensible defaults so the component renders meaningfully when dragged onto a page in Stacki, and forward \`class?: string\` and default slot content where applicable.`,
    `4. Do not modify or delete ${component.file}; keep existing project styling and dependencies intact.`,
  ].join('\n');
}

export async function requestWrapFrameworkComponent(component: ScanFrameworkComponent, translate: Translator, notify: BuildNotify): Promise<void> {
  const outcome = await requestAgentTask(
    agentTask({
      title: translate('palette.framework.wrapWithAI'),
      prompt: wrapFrameworkComponentPrompt(component),
      delivery: 'draft',
      context: { files: [component.file], nodeRefs: [], findingIds: [] },
    }),
  );
  if (outcome.tag === 'sent') {
    notify(translate('palette.components.buildWithAI.draftReady'), 'success');
    return;
  }
  const { message, kind } = agentTaskMessage(outcome, translate);
  notify(message, kind === 'error' ? 'error' : 'success');
}

function devInstallCommand(packageManager: ShadcnLintStatus['packageManager'], packages: readonly string[]): string {
  const joined = packages.join(' ');
  switch (packageManager) {
    case 'pnpm':
      return `pnpm add -D ${joined}`;
    case 'yarn':
      return `yarn add -D ${joined}`;
    case 'bun':
      return `bun add -d ${joined}`;
    case 'npm':
      return `npm install -D ${joined}`;
    default: {
      const exhaustive: never = packageManager;
      return exhaustive;
    }
  }
}

export function shadcnLintSetupPrompt(status: ShadcnLintStatus): string {
  const installPackages = status.linter === 'eslint' ? ['@shadcn/lint'] : status.linter === 'oxlint' ? ['@shadcn/lint'] : ['oxlint', '@shadcn/lint'];
  const installCommand = devInstallCommand(status.packageManager, installPackages);
  const linterGuidance =
    status.linter === 'eslint'
      ? 'This project already uses ESLint. Wire `@shadcn/lint` into the existing ESLint flat config rather than adding a second linter.'
      : status.linter === 'oxlint'
        ? 'This project already uses Oxlint. Add `@shadcn/lint` to `.oxlintrc.json` as a `jsPlugins` entry (`@shadcn/lint`) and enable the recommended shadcn design-system rules.'
        : 'No Oxlint or ESLint config was detected. Recommend setting up Oxlint (`.oxlintrc.json`) with `@shadcn/lint` as a `jsPlugins` entry and adding a `"lint:design"` script in `package.json`.';
  const monorepoNote =
    status.workspaceAppPath === undefined
      ? ''
      : ` This project lives in a monorepo app at \`${status.workspaceAppPath}\`; confirm whether the devDependency and lint config should live in the app package or the workspace root.`;
  return [
    'Set up `@shadcn/lint` (https://github.com/shadcn-ui/lint) to catch Tailwind v4 and shadcn/ui design-system issues (hardcoded colors, deprecated utility classes, invalid tokens, and component conventions) in this project.',
    '',
    `1. Inspect \`package.json\`, lockfiles, and existing linter configs first.${monorepoNote}`,
    `2. ${linterGuidance}`,
    `3. Before running \`${installCommand}\` or editing any config files, show the exact command, package changes, and config diff, and ask for explicit approval.`,
    '4. Do not install anything globally, do not weaken existing lint rules, and run the linter once after approval to verify it passes or report existing warnings clearly.',
  ].join('\n');
}

export async function requestShadcnLintSetup(status: ShadcnLintStatus, translate: Translator, notify: BuildNotify): Promise<void> {
  const outcome = await requestAgentTask(
    agentTask({
      title: translate('settings.shadcn.lint.title'),
      prompt: shadcnLintSetupPrompt(status),
      delivery: 'draft',
      context: { files: [], nodeRefs: [], findingIds: [] },
    }),
  );
  if (outcome.tag === 'sent') {
    notify(translate('settings.shadcn.lint.draftReady'), 'success');
    return;
  }
  const { message, kind } = agentTaskMessage(outcome, translate);
  notify(message, kind === 'error' ? 'error' : 'success');
}
