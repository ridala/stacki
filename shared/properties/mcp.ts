// The Settings panel's MCP tab: the contract between the renderer and the main process. The project's
// `.mcp.json` is listed as summaries (a card's words), never as values: a literal environment or header
// value crosses once, in an `mcp:reveal` reply, when a person edits that server, and never in a listing, an
// error or a log line. The raw file text crosses only for the JSON view, in `mcp:readText`. Every change names
// the revision (a digest of the file's exact bytes) it was authored against, so a file edited outside Stacki
// is refused with `changed` rather than overwritten.
//
// Codex keeps its servers in the person's own `~/.codex/config.toml`, outside the project. The renderer
// never names that path: main uses one fixed path under the home folder. A Codex change names a server of
// the project by name only; main reads that server from `.mcp.json` itself, so no value travels through
// the renderer on its way to the Codex file.
//
// The files are read and printed by mcpJson.ts and mcpToml.ts; this module is the wire shape and the
// parsers for both directions.
import { assert } from '../core/assert';
import { boolean, digest, optional, pathText, record, text } from '../core/boundary';
import type { Digest } from '../core/brand';
import type { Result } from '../core/result';
import { PACKAGE_MANAGERS, type PackageManager } from './packageManager';
import { AGENT_IDS, parseAgentId, type AgentId } from './ai/agentIds';
import {
  MCP_LIMITS,
  MCP_PROBLEM_CODES,
  isMcpServerName,
  parseMcpServerConfig,
  type McpPairSummary,
  type McpProblem,
  type McpServerConfig,
  type McpServerSummary,
} from './mcpConfig';

export const MCP_ERROR_CODES = [
  'changed',
  'name-taken',
  'not-found',
  'invalid-name',
  'invalid',
  'limit',
  'unreadable',
  'too-large',
  'not-text',
  'denied',
  'filesystem',
  'unmappable',
  'codex-unavailable',
  'codex-unsupported',
] as const;
export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

/** A failure the panel shows. The message is fixed text per code: it never holds a name, a value or file text. */
export interface McpError {
  readonly code: McpErrorCode;
  readonly message: string;
}

export type McpResult<T> = Result<T, McpError>;

/** One server of a file as a card shows it. A malformed entry is listed, never dropped. */
export type McpServerItem =
  | { readonly name: string; readonly status: 'server'; readonly summary: McpServerSummary }
  | { readonly name: string; readonly status: 'invalid'; readonly problem: McpProblem };

export interface McpListing {
  /** The digest of the file's bytes, or of no bytes when the file does not exist. */
  readonly revision: Digest;
  readonly exists: boolean;
  readonly servers: readonly McpServerItem[];
}

/** The file as text, for the JSON view. An absent file is empty text. */
export interface McpText {
  readonly revision: Digest;
  readonly exists: boolean;
  readonly text: string;
}

/** What Codex's file looks like to the panel: absent, unusable (and why, in words that hold no content), or readable. */
export type McpCodexState =
  | { readonly state: 'missing' }
  | { readonly state: 'unavailable'; readonly code: Extract<McpErrorCode, 'unreadable' | 'too-large' | 'not-text' | 'denied' | 'codex-unsupported'> }
  | { readonly state: 'ready'; readonly revision: Digest; readonly servers: readonly McpServerItem[] };

export type McpChange =
  | { readonly kind: 'add'; readonly name: string; readonly config: McpServerConfig }
  | { readonly kind: 'update'; readonly name: string; readonly config: McpServerConfig }
  | { readonly kind: 'remove'; readonly name: string };

export type McpCodexChange = { readonly kind: 'put'; readonly name: string } | { readonly kind: 'remove'; readonly name: string };

const CODEX_UNAVAILABLE_CODES = ['unreadable', 'too-large', 'not-text', 'denied', 'codex-unsupported'] as const;

export function parseMcpServerName(input: unknown): string {
  const name = text(input);
  if (!isMcpServerName(name)) {
    throw new Error('MCP: expected a server name');
  }
  return name;
}

function parseConfigField(input: unknown): McpServerConfig {
  const parsed = parseMcpServerConfig(input, 'config');
  if (!parsed.ok) {
    throw new Error('MCP: expected a server configuration');
  }
  return parsed.value;
}

/** A change a person made in the panel, checked before it leaves the renderer and again in main. */
export function parseMcpChange(input: unknown): McpChange {
  const fields = record(input);
  const kind = fields['kind'];
  if (kind === 'add' || kind === 'update') {
    return { kind, name: parseMcpServerName(fields['name']), config: parseConfigField(fields['config']) };
  }
  if (kind === 'remove') {
    return { kind, name: parseMcpServerName(fields['name']) };
  }
  throw new Error('MCP: unknown change');
}

export function parseMcpCodexChange(input: unknown): McpCodexChange {
  const fields = record(input);
  const kind = fields['kind'];
  if (kind === 'put' || kind === 'remove') {
    return { kind, name: parseMcpServerName(fields['name']) };
  }
  throw new Error('MCP: unknown Codex change');
}

/** The raw file text a person saved from the JSON view, bounded here and checked again in main. */
export function parseMcpTextInput(input: unknown): string {
  if (typeof input !== 'string' || input.length > MCP_LIMITS.fileBytesMax) {
    throw new Error('MCP: expected file text within the limit');
  }
  return input;
}

export const parseMcpRevision = digest;

export function parseMcpListing(input: unknown): McpListing {
  const fields = record(input);
  const servers = fields['servers'];
  if (!Array.isArray(servers) || servers.length > MCP_LIMITS.serversMax) {
    throw new Error('MCP: expected a bounded server list');
  }
  const exists = fields['exists'];
  if (typeof exists !== 'boolean') {
    throw new Error('MCP: expected a presence flag');
  }
  return { revision: digest(fields['revision']), exists, servers: servers.map(parseServerItem) };
}

export function parseMcpText(input: unknown): McpText {
  const fields = record(input);
  const exists = fields['exists'];
  if (typeof exists !== 'boolean') {
    throw new Error('MCP: expected a presence flag');
  }
  return { revision: digest(fields['revision']), exists, text: parseMcpTextInput(fields['text']) };
}

export function parseMcpConfigReply(input: unknown): McpServerConfig {
  return parseConfigField(input);
}

export function parseMcpCodexState(input: unknown): McpCodexState {
  const fields = record(input);
  const state = fields['state'];
  if (state === 'missing') {
    return { state };
  }
  if (state === 'unavailable') {
    const code = CODEX_UNAVAILABLE_CODES.find((known) => known === fields['code']);
    if (code === undefined) {
      throw new Error('MCP: unknown Codex failure');
    }
    return { state, code };
  }
  if (state === 'ready') {
    const servers = fields['servers'];
    if (!Array.isArray(servers) || servers.length > MCP_LIMITS.serversMax) {
      throw new Error('MCP: expected a bounded Codex server list');
    }
    return { state, revision: digest(fields['revision']), servers: servers.map(parseServerItem) };
  }
  throw new Error('MCP: unknown Codex state');
}

/** A reply that is either a value parsed by `parseValue` or a failure with a known code. */
export function parseMcpResult<T>(input: unknown, parseValue: (value: unknown) => T): McpResult<T> {
  const fields = record(input);
  if (fields['ok'] === true) {
    return { ok: true, value: parseValue(fields['value']) };
  }
  if (fields['ok'] !== false) {
    throw new Error('MCP: expected a result');
  }
  const failure = record(fields['error']);
  const code = MCP_ERROR_CODES.find((known) => known === failure['code']);
  if (code === undefined) {
    throw new Error('MCP: unknown failure code');
  }
  const message = text(failure['message']);
  assert(message.length <= 200, 'An MCP failure message is short');
  return { ok: false, error: { code, message } };
}

function parseServerItem(input: unknown): McpServerItem {
  const fields = record(input);
  const name = text(fields['name']);
  if (name.length === 0 || name.length > MCP_LIMITS.nameCharsMax) {
    throw new Error('MCP: expected a server name');
  }
  if (fields['status'] === 'server') {
    return { name, status: 'server', summary: parseSummary(fields['summary']) };
  }
  if (fields['status'] === 'invalid') {
    const problem = record(fields['problem']);
    const code = MCP_PROBLEM_CODES.find((known) => known === problem['code']);
    if (code === undefined) {
      throw new Error('MCP: unknown problem code');
    }
    return { name, status: 'invalid', problem: { code, path: text(problem['path']) } };
  }
  throw new Error('MCP: unknown server status');
}

function parseSummary(input: unknown): McpServerSummary {
  const fields = record(input);
  const transport = fields['transport'];
  if (transport === 'stdio') {
    const argumentCount = fields['argumentCount'];
    if (typeof argumentCount !== 'number' || !Number.isSafeInteger(argumentCount) || argumentCount < 0 || argumentCount > MCP_LIMITS.argsMax) {
      throw new Error('MCP: expected an argument count');
    }
    return {
      transport,
      command: text(fields['command']),
      argumentCount,
      env: parsePairSummaries(fields['env']),
      secretNames: parseNames(fields['secretNames']),
    };
  }
  if (transport === 'http' || transport === 'sse') {
    return { transport, host: text(fields['host']), headers: parsePairSummaries(fields['headers']), secretNames: parseNames(fields['secretNames']) };
  }
  throw new Error('MCP: unknown transport');
}

function parsePairSummaries(input: unknown): readonly McpPairSummary[] {
  if (!Array.isArray(input) || input.length > MCP_LIMITS.pairsMax) {
    throw new Error('MCP: expected bounded pairs');
  }
  return input.map((item): McpPairSummary => {
    const fields = record(item);
    return { name: text(fields['name']), reference: optional(text)(fields['reference']) };
  });
}

function parseNames(input: unknown): readonly string[] {
  if (!Array.isArray(input) || input.length > MCP_LIMITS.pairsMax * 4) {
    throw new Error('MCP: expected bounded names');
  }
  return input.map((item) => text(item));
}

// ---------------------------------------------------------------------------
// Signing in to servers: what the window asks of `ai:mcpAuth` and what comes back (and arrives on
// `ai:mcpAuthState`). The work is the agent's own CLI (electron/handlers/ai/mcpSignIn.ts). What crosses is a
// server's name, which agent, where it stands and a word about what happened: never an address, a code, a token
// or anything the CLI printed.
// ---------------------------------------------------------------------------

/** Where one server stands for one agent, as that agent's own CLI reports it. */
export const MCP_AUTH_STATES = [
  /** No sign-in applies: a local command, a server with a token or key, or one the CLI says needs none. Nothing is shown. */
  'none',
  'needs-sign-in',
  /** Claude reached it; Codex is signed in to it. */
  'connected',
  /** A sign-in is under way in the browser. */
  'signing-in',
  /** It could not be checked just now. */
  'unknown',
  /** Not checked yet: the project is not yet allowed to run agents, so nothing is contacted until the person asks. */
  'not-checked',
  /** The person's CLI is too old to sign in to servers from outside its own screen. */
  'unsupported-cli',
  /** The person turned this server off in the agent's own settings. */
  'blocked',
] as const;
export type McpAuthState = (typeof MCP_AUTH_STATES)[number];

/** What just happened, for a toast. */
export const MCP_AUTH_NOTICES = [
  'signed-in',
  'signed-out',
  'cancelled',
  'failed',
  'timed-out',
  /** The CLI gave a sign-in page that is not a secure web address: it was not opened. */
  'unsafe-page',
  'unsupported-cli',
  'blocked',
  'not-needed',
  'sign-out-failed',
  /** Too many sign-ins are already waiting. */
  'busy',
] as const;
export type McpAuthNotice = (typeof MCP_AUTH_NOTICES)[number];

export interface McpAuthEntry {
  readonly agent: AgentId;
  readonly name: string;
  readonly state: McpAuthState;
}

export type McpAuthAction = 'check' | 'signIn' | 'reopen' | 'cancel' | 'signOut';
const ACTIONS = ['check', 'signIn', 'reopen', 'cancel', 'signOut'] as const satisfies readonly McpAuthAction[];

export type McpAuthRequest =
  /** Every server a sign-in could apply to. `fresh` asks the CLIs again rather than using what they last said. */
  { readonly kind: 'list'; readonly freshness: 'cached' | 'fresh' } | { readonly kind: McpAuthAction; readonly agent: AgentId; readonly name: string };

export interface McpAuthReply {
  readonly servers: readonly McpAuthEntry[];
  readonly notice: McpAuthNotice | undefined;
}

export interface McpAuthPush {
  readonly projectPath: string;
  readonly entry: McpAuthEntry;
  readonly notice: McpAuthNotice | undefined;
}

/** One entry per agent per server, and each side lists at most `serversMax`. */
export const MCP_AUTH_ENTRIES_MAX = MCP_LIMITS.serversMax * AGENT_IDS.length;

/** A name a CLI can be given as an argument: the file's own naming rule, and never one that reads as an option. */
export function isSignInServerName(name: string): boolean {
  assert(MCP_LIMITS.nameCharsMax > 0, 'A server name has a bound');
  return isMcpServerName(name) && !name.startsWith('-');
}

function signInServerName(input: unknown): string {
  const name = text(input);
  if (!isSignInServerName(name)) {
    throw new Error('MCP sign-in: expected a server name');
  }
  assert(!name.startsWith('-'), 'A server name is never read as an option');
  assert(name.length <= MCP_LIMITS.nameCharsMax, 'A server name is bounded');
  return name;
}

export function parseMcpAuthRequest(input: unknown): McpAuthRequest {
  const fields = record(input);
  if (fields['kind'] === 'list') {
    const freshness = fields['freshness'];
    if (freshness !== 'cached' && freshness !== 'fresh') {
      throw new Error('MCP sign-in: expected a freshness');
    }
    return { kind: 'list', freshness };
  }
  const kind = ACTIONS.find((candidate) => candidate === fields['kind']);
  if (kind === undefined) {
    throw new Error('MCP sign-in: unknown request');
  }
  return { kind, agent: parseAgentId(fields['agent']), name: signInServerName(fields['name']) };
}

function parseAuthEntry(input: unknown): McpAuthEntry {
  const fields = record(input);
  const state = MCP_AUTH_STATES.find((candidate) => candidate === fields['state']);
  if (state === undefined) {
    throw new Error('MCP sign-in: unknown state');
  }
  return { agent: parseAgentId(fields['agent']), name: signInServerName(fields['name']), state };
}

function parseNotice(input: unknown): McpAuthNotice | undefined {
  if (input === undefined) {
    return undefined;
  }
  const notice = MCP_AUTH_NOTICES.find((candidate) => candidate === input);
  if (notice === undefined) {
    throw new Error('MCP sign-in: unknown notice');
  }
  return notice;
}

export function parseMcpAuthReply(input: unknown): McpAuthReply {
  const fields = record(input);
  const servers = fields['servers'];
  if (!Array.isArray(servers) || servers.length > MCP_AUTH_ENTRIES_MAX) {
    throw new Error('MCP sign-in: expected a bounded server list');
  }
  const parsed = servers.map(parseAuthEntry);
  assert(parsed.length === servers.length, 'No entry is dropped from a reply');
  assert(parsed.length <= MCP_AUTH_ENTRIES_MAX, 'A reply stays bounded');
  return { servers: parsed, notice: parseNotice(fields['notice']) };
}

export function parseMcpAuthPush(input: unknown): McpAuthPush {
  const fields = record(input);
  return { projectPath: text(fields['projectPath']), entry: parseAuthEntry(fields['entry']), notice: parseNotice(fields['notice']) };
}

// ---------------------------------------------------------------------------
// Project-aware AI toolkit recommendations: detected UI libraries (shadcn,
// HeroUI, Hugeicons), whether their official MCP server and agent skill are
// already configured, and optional `@shadcn/lint` setup status.
// ---------------------------------------------------------------------------

export const AI_TOOLKIT_IDS = ['shadcn', 'heroui', 'hugeicons'] as const;
export type AiToolkitId = (typeof AI_TOOLKIT_IDS)[number];

export const AI_TOOLKIT_MCP_PROVIDERS = ['heroui', 'hugeicons'] as const;
export type AiToolkitMcpProvider = (typeof AI_TOOLKIT_MCP_PROVIDERS)[number];

export const SHADCN_LINT_LINTERS = ['oxlint', 'eslint', 'none'] as const;
export type ShadcnLintLinter = (typeof SHADCN_LINT_LINTERS)[number];

export interface AiToolkitRecommendation {
  readonly id: AiToolkitId;
  readonly mcpProviderId?: AiToolkitMcpProvider;
  readonly mcpConnected: boolean;
  readonly skillSlug: string;
  readonly skillInstalled: boolean;
  readonly skillPath?: string;
  readonly packagePath?: string;
}

export interface ShadcnLintStatus {
  readonly applicable: boolean;
  readonly installed: boolean;
  readonly linter: ShadcnLintLinter;
  readonly packageManager: PackageManager;
  readonly workspaceAppPath?: string;
}

export interface ProjectAiToolkit {
  readonly recommendations: readonly AiToolkitRecommendation[];
  readonly shadcnLint: ShadcnLintStatus;
}

export function parseProjectAiToolkit(input: unknown): ProjectAiToolkit {
  const fields = record(input);
  const rawList = fields['recommendations'];
  if (!Array.isArray(rawList) || rawList.length > AI_TOOLKIT_IDS.length) {
    throw new Error('AI toolkit: expected bounded recommendations list');
  }
  const recommendations = rawList.map(parseRecommendation);
  const lintFields = record(fields['shadcnLint']);
  const linter = SHADCN_LINT_LINTERS.find((candidate) => candidate === lintFields['linter']);
  if (linter === undefined) {
    throw new Error('AI toolkit: unknown linter');
  }
  const packageManager = PACKAGE_MANAGERS.find((candidate) => candidate === lintFields['packageManager']);
  if (packageManager === undefined) {
    throw new Error('AI toolkit: unknown packageManager');
  }
  const workspaceAppPath = optional(pathText)(lintFields['workspaceAppPath']);
  return {
    recommendations,
    shadcnLint: {
      applicable: boolean(lintFields['applicable']),
      installed: boolean(lintFields['installed']),
      linter,
      packageManager,
      ...(workspaceAppPath === undefined ? {} : { workspaceAppPath }),
    },
  };
}

function parseRecommendation(input: unknown): AiToolkitRecommendation {
  const fields = record(input);
  const id = AI_TOOLKIT_IDS.find((candidate) => candidate === fields['id']);
  if (id === undefined) {
    throw new Error('AI toolkit: unknown recommendation id');
  }
  const rawProvider = fields['mcpProviderId'];
  let mcpProviderId: AiToolkitMcpProvider | undefined;
  if (rawProvider !== undefined) {
    mcpProviderId = AI_TOOLKIT_MCP_PROVIDERS.find((candidate) => candidate === rawProvider);
    if (mcpProviderId === undefined) {
      throw new Error('AI toolkit: unknown MCP provider id');
    }
  }
  const skillPath = optional(pathText)(fields['skillPath']);
  const packagePath = optional(pathText)(fields['packagePath']);
  return {
    id,
    ...(mcpProviderId === undefined ? {} : { mcpProviderId }),
    mcpConnected: boolean(fields['mcpConnected']),
    skillSlug: text(fields['skillSlug']),
    skillInstalled: boolean(fields['skillInstalled']),
    ...(skillPath === undefined ? {} : { skillPath }),
    ...(packagePath === undefined ? {} : { packagePath }),
  };
}

/**
 * Generates a clean, valid `SKILL.md` scaffold for a detected UI ecosystem, tailored to the project's
 * structure (including shared monorepo package paths when present).
 */
export function recommendedSkillSource(id: AiToolkitId, options: { readonly packagePath?: string } = {}): string {
  switch (id) {
    case 'shadcn': {
      const locationNote =
        options.packagePath === undefined
          ? 'Inspect `components.json` at the project root before adding or editing UI components.'
          : `This monorepo stores its shadcn configuration in \`${options.packagePath}/components.json\`. Run shadcn CLI commands against that package or preserve its alias paths.`;
      return [
        '---',
        'name: shadcn',
        'description: Manage and build UI with this project’s shadcn/ui components, design tokens, and components.json configuration.',
        '---',
        '',
        '# shadcn/ui project skill',
        '',
        'Reference: https://ui.shadcn.com/docs/skills',
        '',
        '## Workflow',
        `- ${locationNote}`,
        '- Run `npx shadcn@latest info --json` (or read `components.json`) to check the base library, Tailwind version, icon library, and path aliases.',
        '- Prefer composing existing installed UI primitives over creating duplicate buttons, inputs, dialogs, or cards.',
        '- Use semantic design-system tokens (`bg-background`, `text-foreground`, `bg-primary`, `text-muted-foreground`, `border-border`) instead of hardcoded hex colors or arbitrary pixel values.',
        '- Search and add missing primitives through `npx shadcn@latest search` and `npx shadcn@latest add` after confirming with the user.',
        '',
      ].join('\n');
    }
    case 'heroui':
      return [
        '---',
        'name: heroui-react',
        'description: Build and style UI with HeroUI v3 React components, compound patterns, Tailwind v4 tokens, and the HeroUI MCP server.',
        '---',
        '',
        '# HeroUI React project skill',
        '',
        'Reference: https://heroui.com/en/docs/react/getting-started/agent-skills',
        '',
        '## Workflow',
        '- Check installed documentation under `node_modules/@heroui/react/docs/` or query the connected `HeroUI` MCP server (`@heroui/react-mcp`) before writing component code.',
        '- Follow HeroUI v3 conventions: compound components, Tailwind CSS v4 styling, and no legacy `<HeroUIProvider>` wrapper.',
        '- Use HeroUI semantic CSS variables (`--accent`, `--background`, `--foreground`, `--surface`, `--overlay`, `--danger`, `--radius`) and preserve light/dark `@variant` or `[data-theme]` scopes.',
        '- When placing interactive HeroUI React components inside Astro pages, wrap them in a clean `.astro` component with an appropriate hydration directive (`client:load` or `client:visible`).',
        '',
      ].join('\n');
    case 'hugeicons':
      return [
        '---',
        'name: hugeicons',
        'description: Search and insert verified Hugeicons icons using the Hugeicons MCP server and installed icon packages.',
        '---',
        '',
        '# Hugeicons project skill',
        '',
        'Reference: https://hugeicons.com/docs/integrations/skill',
        '',
        '## Workflow',
        '- Always look up exact icon export names with the connected `Hugeicons` MCP server (`search_icons`, `get_icon_code`) instead of guessing names or hand-writing inline SVG paths.',
        '- Match the packages already installed in `package.json` (for example `@hugeicons/react` with `@hugeicons/core-free-icons`).',
        '- Render icons with `<HugeiconsIcon icon={...} size={...} strokeWidth={...} />` and use `currentColor` so icons inherit theme colors cleanly.',
        '- Do not mix unrelated icon libraries when Hugeicons already provides the needed icon.',
        '',
      ].join('\n');
    default: {
      const exhaustive: never = id;
      return exhaustive;
    }
  }
}
