import { agentTask } from '../../../shared/properties/agentTask';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { agentTaskMessage, copyAgentPrompt, requestAgentTask } from '../../lib/agentTasks';

type Notify = (message: string, kind: 'success' | 'error') => void;

export function componentBuildPrompt(): string {
  return `Build one accessible Dialog for this Astro project using Vercel UI SDK. Make it insertable and editable in Stacki.

1. Read the project instructions, manifest, lockfile, Astro config, component root, existing shadcn setup, and installed SDK docs. Use the project's package manager and reuse compatible setup. Match the Astro React integration to the project's Astro version. Use React and React DOM 19 with React types 19.2.10 or later. Use exact project-local pins @ui-sdk/react@0.1.0-beta.17 and @ui-sdk/core@0.1.0-beta.17. Import the Dialog parts from @ui-sdk/react/dialog.
2. Before changing setup, show the project-local commands, dependency and lockfile changes, and any Astro config changes. Explain the dependencies, license, and transitive cost. Ask for explicit approval and wait before installing or changing setup. If the package manager is ambiguous, React is missing or incompatible, or project policy blocks the pins, explain the options first. Avoid global installs, shell-wide setup, and elevated permissions. Keep Stacki's editor dependencies, the starter, and the existing shadcn setup intact. The Dialog needs no runtime bridge, WebMCP, or extra preview tooling.
3. Show the proposed files and recipe changes before writing. Create an ordinary .astro wrapper under the project's component root. Expose a typed string label prop and a named body slot. Pass both to one hydrated React island containing the Dialog trigger, title, content, and close button. Use server rendering for the trigger and keep meaningful static page copy, headings, and real links outside the closed Dialog. Preserve the layout, title, description, canonical URL, Open Graph, JSON-LD, robots, sitemap, site and base settings, and route statuses. Scope component CSS and reuse project styling tokens.
4. Add a bounded insertion recipe to .stacki/components.json keyed by the wrapper's project-relative path. Seed label and use an element child with a slot prop set to body. Keep existing recipe entries and instances intact. Use ordinary Astro props and slots in source files.
5. In the project's GitHub checks, run astro-studio check-project <project-directory> and the project's Astro check and production build. Fix missing files, invalid slots, and recipe cycles. Compare raw HTML and hydrated DOM for static content, SEO tags, and hydration warnings. In Stacki, verify discovery, insertion, editing props and slot content, save, undo, redo, and reopen. In interactive preview, check the Dialog's accessible name, focus on open, Tab containment, Escape, and focus return. Report the versions, file and dependency diffs, and anything you could not verify.`;
}

export async function requestBuildComponent(translate: Translator, notify: Notify): Promise<void> {
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

export async function copyBuildComponent(translate: Translator, notify: Notify): Promise<void> {
  // Studio's own handler writes to chat. Copy directly to keep that state untouched.
  const { message, kind } = agentTaskMessage(await copyAgentPrompt(componentBuildPrompt()), translate);
  notify(message, kind === 'error' ? 'error' : 'success');
}
