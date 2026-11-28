import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { record } from '../../shared/core/boundary';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { PAGE_MD_RE, readFence } from '../documents/pageRequests';
import {
  PAGES_FOLDER,
  folderChoiceProblem,
  foldersFor,
  isCustomized,
  isWithin,
  parseProjectFolder,
  readProjectFoldersSource,
  withFolders,
  type ProjectFolders,
} from '../../shared/properties/projectFolders';
import {
  PROJECT_SETUP_EXAMPLES_MAX,
  PROJECT_SETUP_FINDINGS_MAX,
  PROJECT_SETUP_FINDING_FILES_MAX,
  PROJECT_SETUP_KINDS,
  type ProjectSetupFinding,
  type ProjectSetupFindingSeverity,
  type ProjectSetupKind,
  type ProjectSetupReport,
  type ProjectSetupSuggestion,
} from '../../shared/ipc/projectSetup';
import {
  hashText,
  setupEvidenceText,
  setupFramingHeaders,
  setupInventory,
  setupMetadata,
  setupPages,
  setupPathAliases,
  setupSyntax,
  type SetupFile,
  type SetupPathAlias,
} from './projectSetupDisk';
import { detectPackageManager } from './packageManager';
import { hasDependencies } from './projectFiles';
import { writeProjectMetadata } from './projectMetadata';
import { findEnclosingWorkspace } from './workspaceAstro';

const EVIDENCE_BYTES_MAX = 8 * 1024 * 1024;
const SCAN_BUDGET_MS = 1_500;

interface SetupSnapshot {
  readonly report: ProjectSetupReport;
  readonly metadata: ReturnType<typeof setupMetadata>;
}

export function scanProjectSetup(root: string): ProjectSetupReport {
  return setupSnapshot(root).report;
}

export function applyProjectSetup(
  root: string,
  input: { readonly revision: string; readonly kinds: readonly ProjectSetupKind[] },
  announce: () => void,
): Result<ProjectSetupReport> {
  const snapshot = setupSnapshot(root);
  if (snapshot.report.revision !== input.revision) {
    return staleProjectSetup();
  }
  if (input.kinds.length === 0) {
    return ok(snapshot.report);
  }
  if (snapshot.metadata.kind !== 'editable') {
    return staleProjectSetup();
  }
  const selected = snapshot.report.suggestions.filter(({ kind }) => input.kinds.includes(kind));
  if (selected.length !== input.kinds.length) {
    return staleProjectSetup();
  }
  const source = sourceWithMappings(snapshot.metadata.base, selected);
  const parsed = readProjectFoldersSource(source);
  if (parsed.kind === 'invalid') {
    // i18n-ignore: The setup UI translates this stable error code.
    return err({ code: 'settings-unavailable', message: 'The proposed folder settings exceed the supported size.' });
  }
  assert(parsed.kind === 'ready', 'A proposed settings source must parse into a folder configuration');
  if (source === snapshot.metadata.base) {
    return ok(snapshot.report);
  }
  const saved = writeProjectMetadata(
    root,
    { kind: 'folders', source, ...(snapshot.metadata.base === undefined ? {} : { base: snapshot.metadata.base }) },
    { exclusions: 'preserve' },
  );
  if (!saved.ok) {
    return saved.error.code === 'conflict' || saved.error.code === 'write-race' || saved.error.code === 'exists' ? staleProjectSetup() : saved;
  }
  announce();
  return ok(setupSnapshot(root).report);
}

export function staleProjectSetup(): Result<never> {
  // i18n-ignore: The setup UI translates this stable error code.
  return err({ code: 'stale', message: 'Project setup changed. Scan again to review the current folders.' });
}

function setupSnapshot(root: string): SetupSnapshot {
  const deadline = performance.now() + SCAN_BUDGET_MS;
  // Check between operations because a synchronous filesystem call can outlast its time budget.
  const timeAvailable = () => performance.now() < deadline;
  const pages = setupPages(root);
  const metadata = setupMetadata(root);
  const aliases = setupPathAliases(root);
  const framing = setupFramingHeaders(root);
  const workspace = findEnclosingWorkspace(root);
  const packageManager = detectPackageManager(root);
  const dependenciesInstalled = hasDependencies(root);
  const config = metadata.kind === 'editable' ? metadata.config : undefined;
  const roots = ['src', 'public'];
  if (!roots.some((folder) => isWithin(folder, pages.folder))) {
    roots.push(pages.folder);
  }
  const inventory = setupInventory(root, roots, timeAvailable);
  const evidence = collectEvidence(root, inventory.files, pages.folder, aliases.aliases, timeAvailable);
  const incomplete = inventory.incomplete || evidence.incomplete;
  const candidates =
    !incomplete && pages.source !== 'unverified' && metadata.kind === 'editable'
      ? folderSuggestions(inventory.files, config, pages.folder, evidence.roles, timeAvailable)
      : [];
  const complete = !incomplete && candidates !== undefined && timeAvailable();
  const suggestions = complete ? candidates : [];
  const findings = collectFindings({
    workspace,
    packageManager,
    dependenciesInstalled,
    pages,
    incomplete: !complete,
    settingsKind: metadata.kind,
    ssrDynamicRoutes: evidence.ssrDynamicRoutes,
    frameworkComponentCount: inventory.frameworkComponentCount,
    frameworkComponents: inventory.frameworkComponents,
    framingFile: framing?.file,
  });
  const report = {
    pagesFolder: pages.folder,
    pagesSource: pages.source,
    desktopPages: inventory.files.filter(({ path: file }) => desktopPage(file, pages.folder)).length,
    studioPages: inventory.files.filter(({ path: file }) => /^src\/pages\/.+\.(astro|md|mdx)$/.test(file) && studioPath(file)).length,
    incomplete: !complete,
    settings: metadata.kind,
    suggestions,
    ...(workspace === undefined ? {} : { workspaceAppPath: workspace.relativeAppPath }),
    packageManager,
    dependenciesInstalled,
    findings,
  };
  const revision = hashText(
    JSON.stringify([
      root,
      report,
      pages.witness,
      aliases.witness,
      framing?.witness,
      metadata.kind === 'editable' ? metadata.base : undefined,
      inventory.files,
      evidence.witnesses,
    ]),
  );
  assert(suggestions.length <= PROJECT_SETUP_KINDS.length, 'Setup reports at most one suggestion per kind');
  assert(findings.length <= PROJECT_SETUP_FINDINGS_MAX, 'Setup findings stay within the finding limit');
  return { report: { ...report, revision }, metadata };
}

const SEVERITY_ORDER: Readonly<Record<ProjectSetupFindingSeverity, number>> = {
  blocker: 0,
  warning: 1,
  info: 2,
};

function collectFindings(input: {
  readonly workspace: ReturnType<typeof findEnclosingWorkspace>;
  readonly packageManager: ReturnType<typeof detectPackageManager>;
  readonly dependenciesInstalled: boolean;
  readonly pages: ReturnType<typeof setupPages>;
  readonly incomplete: boolean;
  readonly settingsKind: 'editable' | 'unavailable';
  readonly ssrDynamicRoutes: readonly string[];
  readonly frameworkComponentCount: number;
  readonly frameworkComponents: readonly string[];
  readonly framingFile: string | undefined;
}): readonly ProjectSetupFinding[] {
  const findings: ProjectSetupFinding[] = [];
  if (!input.dependenciesInstalled) {
    const location = input.workspace === undefined ? 'the project root' : 'the monorepo root';
    findings.push({
      code: 'dependencies-missing',
      severity: 'blocker',
      summary: `Astro dependencies are not installed (${input.packageManager} node_modules missing).`,
      action: `Run ${input.packageManager} install at ${location} before starting Stacki preview.`,
      files: ['package.json'],
    });
  }
  if (input.workspace !== undefined) {
    findings.push({
      code: 'workspace-nested-app',
      severity: 'info',
      summary: `Nested Astro app inside monorepo workspace (${input.workspace.relativeAppPath}).`,
      action: `Keep ${input.workspace.relativeAppPath} as the Stacki app root and install dependencies at the workspace root with ${input.packageManager}.`,
      files: ['package.json'],
    });
  }
  if (input.pages.source === 'unverified') {
    findings.push({
      code: 'astro-config-unverified',
      severity: 'warning',
      summary: 'Stacki could not statically verify srcDir in the Astro configuration.',
      action: 'Use one literal astro.config.mjs or astro.config.ts with a static srcDir (or default src/) so Desktop and Studio resolve pages consistently.',
      files: input.pages.configFile === undefined ? [] : [input.pages.configFile],
    });
  }
  if (input.pages.externalConfigImports.length > 0 && input.pages.configFile !== undefined) {
    findings.push({
      code: 'astro-config-external-imports',
      severity: 'warning',
      summary: `Astro config imports ${input.pages.externalConfigImports.length} file(s) outside this app folder (${input.pages.externalConfigImports.join(', ')}).`,
      action:
        'Desktop preview runs in place, but standalone Stacki Studio draft copies only copy this app folder unless external imports are guarded or self-contained.',
      files: [input.pages.configFile],
    });
  }
  if (input.ssrDynamicRoutes.length > 0) {
    findings.push({
      code: 'ssr-dynamic-routes',
      severity: 'warning',
      summary: `Dynamic route template(s) have no getStaticPaths export (${input.ssrDynamicRoutes.join(', ')}).`,
      action:
        'Stacki route picker lists getStaticPaths entries; keep SSR intact and ensure sample slugs or manual preview URLs are documented for visual editing.',
      files: input.ssrDynamicRoutes.slice(0, PROJECT_SETUP_FINDING_FILES_MAX),
    });
  }
  if (input.framingFile !== undefined) {
    findings.push({
      code: 'framing-headers-present',
      severity: 'warning',
      summary: `Middleware sets iframe framing headers (X-Frame-Options / frame-ancestors) in ${input.framingFile}.`,
      action: 'Verify the page loads in Stacki preview canvas; keep production framing headers intact and only relax framing for local preview if blocked.',
      files: [input.framingFile],
    });
  }
  if (input.frameworkComponentCount > 0) {
    findings.push({
      code: 'framework-components-only',
      severity: 'info',
      summary: `Found ${input.frameworkComponentCount} framework component file(s) (.tsx/.jsx/.vue/.svelte) under src/components.`,
      action:
        'Stacki inserts .astro components directly; wrap interactive islands in .astro wrappers (or add .stacki/components.json recipes) to place them from the palette.',
      files: input.frameworkComponents.slice(0, PROJECT_SETUP_FINDING_FILES_MAX),
    });
  }
  if (input.incomplete) {
    findings.push({
      code: 'scan-incomplete',
      severity: 'warning',
      summary: 'Some files or directories were skipped during the bounded setup scan.',
      action: 'Check for oversized files, symlinked directories, or nested node_modules inside src/ before relying on automatic folder suggestions.',
      files: [],
    });
  }
  if (input.settingsKind === 'unavailable') {
    findings.push({
      code: 'settings-unavailable',
      severity: 'warning',
      summary: 'Existing .stacki/folders.json could not be read or validated.',
      action: 'Inspect and fix .stacki/folders.json before saving folder mappings from Stacki.',
      files: ['.stacki/folders.json'],
    });
  }
  findings.sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
  return findings.slice(0, PROJECT_SETUP_FINDINGS_MAX);
}

function sourceWithMappings(base: string | undefined, selected: readonly ProjectSetupSuggestion[]): string {
  assert(selected.length >= 1, 'Setup applies at least one folder mapping');
  // The settings parser already accepted these bytes. Keep the raw keys so an old
  // styles mapping keeps its original representation, even with inferred variables.
  const original: unknown = base === undefined ? { version: 1 } : JSON.parse(base);
  const settings = record(original);
  const folders = settings['folders'] === undefined ? {} : record(settings['folders']);
  const mappings = Object.fromEntries(selected.map(({ kind, folders: paths }) => [kind, paths]));
  assert(Object.keys(mappings).length === selected.length, 'Setup merges only distinct reviewed keys');
  return JSON.stringify({ ...settings, folders: { ...folders, ...mappings } }, undefined, 2) + '\n';
}

function desktopPage(file: string, folder: string): boolean {
  if (!isWithin(folder, file)) {
    return false;
  }
  const relative = file.slice(folder.length + 1);
  if (relative.startsWith('..') || relative.split('/').some((segment) => segment.startsWith('_'))) {
    return false;
  }
  return file.endsWith('.astro') || PAGE_MD_RE.test(file);
}

function studioPath(file: string): boolean {
  // Studio's project server walks src/public and its filePath parser uses this grammar.
  return file.length <= 500 && /^(src|public)\/[\w./ \[\]-]+$/.test(file) && file.split('/').every((segment) => !segment.startsWith('.'));
}

function catalogFiles(files: readonly SetupFile[], config: ProjectFolders | undefined) {
  const components = foldersFor('components', config);
  const layouts = foldersFor('layouts', config);
  const mapped = PROJECT_SETUP_KINDS.some((kind) => isCustomized(kind, config));
  const folders = [...components, ...layouts];
  const desktop = new Set<string>();
  const studio = new Set<string>();
  for (const file of files) {
    if (!file.path.endsWith('.astro')) {
      continue;
    }
    const selected = folders.some((folder) => isWithin(folder, file.path));
    if (selected) {
      desktop.add(file.path);
    }
    if (studioPath(file.path) && (mapped ? selected : !isWithin(PAGES_FOLDER, file.path))) {
      studio.add(file.path);
    }
  }
  return { desktop, studio };
}

function folderSuggestions(
  files: readonly SetupFile[],
  config: ProjectFolders | undefined,
  pages: string,
  roles: ReadonlyMap<string, ReadonlySet<ProjectSetupKind>>,
  timeAvailable: () => boolean,
): readonly ProjectSetupSuggestion[] | undefined {
  const before = catalogFiles(files, config);
  const candidates = new Map<string, Set<ProjectSetupKind | 'unknown'>>();
  for (const { path: file } of files) {
    if (!timeAvailable()) {
      return undefined;
    }
    if (!file.startsWith('src/') || !file.endsWith('.astro')) {
      continue;
    }
    // Every descendant votes so a mixed or unclassified directory cannot be swept into a panel.
    const role = roles.get(file) ?? inferFolderRole(file);
    const segments = file.split('/').slice(0, -1);
    for (let depth = 2; depth <= segments.length; depth += 1) {
      const folder = segments.slice(0, depth).join('/');
      const votes = candidates.get(folder) ?? new Set<ProjectSetupKind | 'unknown'>();
      if (role.size === 0) {
        votes.add('unknown');
      }
      for (const kind of role) {
        votes.add(kind);
      }
      candidates.set(folder, votes);
    }
  }
  const suggestions: ProjectSetupSuggestion[] = [];
  const ordered = [...candidates.keys()].sort();
  for (const kind of PROJECT_SETUP_KINDS) {
    if (isCustomized(kind, config)) {
      continue;
    }
    const existing = foldersFor(kind, config);
    const other = foldersFor(kind === 'components' ? 'layouts' : 'components', config);
    const folders = [...existing];
    for (const folder of ordered) {
      if (!timeAvailable()) {
        return undefined;
      }
      const votes = candidates.get(folder);
      if (votes?.size !== 1 || !votes.has(kind)) {
        continue;
      }
      if (isWithin(pages, folder) || isWithin(folder, pages) || other.some((value) => isWithin(value, folder) || isWithin(folder, value))) {
        continue;
      }
      if (!allowedSetupFolder(kind, folders, folder)) {
        continue;
      }
      folders.push(folder);
    }
    if (folders.length > existing.length) {
      const after = catalogFiles(files, withFolders(config, kind, folders));
      if (after.desktop.size > before.desktop.size) {
        suggestions.push({
          kind,
          folders,
          desktopBefore: before.desktop.size,
          desktopAfter: after.desktop.size,
          studioBefore: before.studio.size,
          studioAfter: after.studio.size,
          desktopAdded: catalogExamples(after.desktop, before.desktop),
          studioAdded: catalogExamples(after.studio, before.studio),
          studioRemoved: catalogExamples(before.studio, after.studio),
        });
      }
    }
  }
  return suggestions;
}

function catalogExamples(files: ReadonlySet<string>, other: ReadonlySet<string>): readonly string[] {
  const examples: string[] = [];
  for (const file of files) {
    if (!other.has(file)) {
      examples.push(file);
    }
    if (examples.length >= PROJECT_SETUP_EXAMPLES_MAX) {
      break;
    }
  }
  return examples;
}

function allowedSetupFolder(kind: ProjectSetupKind, existing: readonly string[], folder: string): boolean {
  try {
    return folderChoiceProblem(kind, existing, parseProjectFolder(folder)) === undefined;
  } catch {
    return false;
  }
}

function inferFolderRole(file: string): ReadonlySet<ProjectSetupKind> {
  const folders = file.toLowerCase().split('/').slice(0, -1);
  const roles = new Set<ProjectSetupKind>();
  if (folders.some((folder) => /^(?:layouts|templates)$/.test(folder))) {
    roles.add('layouts');
  }
  if (folders.some((folder) => /^(?:components|ui|widgets)$/.test(folder))) {
    roles.add('components');
  }
  return roles;
}

function collectEvidence(root: string, files: readonly SetupFile[], pages: string, aliases: readonly SetupPathAlias[], timeAvailable: () => boolean) {
  const astroFiles = new Set(files.filter((file) => file.path.endsWith('.astro')).map((file) => file.path));
  const roles = new Map<string, Set<ProjectSetupKind>>();
  const ssrDynamicRoutes: string[] = [];
  const witnesses: string[] = [];
  let remaining = EVIDENCE_BYTES_MAX;
  let incomplete = false;
  for (const file of files) {
    if (!timeAvailable()) {
      incomplete = true;
      break;
    }
    if (!astroFiles.has(file.path)) {
      continue;
    }
    if (file.size > remaining) {
      incomplete = true;
      continue;
    }
    remaining -= file.size;
    const source = setupEvidenceText(root, file);
    if (source === undefined) {
      incomplete = true;
      continue;
    }
    witnesses.push(hashText(source));
    const fence = readFence(source);
    if (fence.kind === 'unreadable') {
      incomplete = true;
    }
    const isDynamicPage = desktopPage(file.path, pages) && /\[[^\]]+\]/.test(file.path);
    if (fence.kind !== 'fence') {
      if (isDynamicPage && ssrDynamicRoutes.length < PROJECT_SETUP_FINDING_FILES_MAX) {
        ssrDynamicRoutes.push(file.path);
      }
      continue;
    }
    if (isDynamicPage && !/\bgetStaticPaths\b/.test(fence.code) && ssrDynamicRoutes.length < PROJECT_SETUP_FINDING_FILES_MAX) {
      ssrDynamicRoutes.push(file.path);
    }
    if (!fence.code.includes('import')) {
      continue;
    }
    const syntax = setupSyntax('frontmatter.ts', fence.code);
    if (syntax === undefined) {
      incomplete = true;
      continue;
    }
    for (const statement of syntax.statements) {
      if (ts.isImportDeclaration(statement)) {
        recordImportRole(file.path, source.slice(fence.length), statement, { astroFiles, pages, aliases, roles });
      }
    }
  }
  return { roles, ssrDynamicRoutes, witnesses, incomplete };
}

function resolveImportTarget(importer: string, specifier: string, aliases: readonly SetupPathAlias[]): string | undefined {
  if (/^\.\.?\//.test(specifier)) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  }
  for (const alias of aliases) {
    if (specifier.startsWith(alias.prefix)) {
      return path.posix.normalize(`${alias.targetPrefix}${specifier.slice(alias.prefix.length)}`);
    }
  }
  return undefined;
}

function recordImportRole(
  importer: string,
  markup: string,
  statement: ts.ImportDeclaration,
  evidence: {
    readonly astroFiles: ReadonlySet<string>;
    readonly pages: string;
    readonly aliases: readonly SetupPathAlias[];
    readonly roles: Map<string, Set<ProjectSetupKind>>;
  },
): void {
  const binding = statement.importClause?.name?.text;
  if (binding === undefined || statement.importClause?.isTypeOnly === true || !/^[A-Z][\w]*$/.test(binding)) {
    return;
  }
  const specifier = statement.moduleSpecifier;
  if (!ts.isStringLiteral(specifier)) {
    return;
  }
  const target = resolveImportTarget(importer, specifier.text, evidence.aliases);
  if (target === undefined || !evidence.astroFiles.has(target) || isWithin(evidence.pages, target)) {
    return;
  }
  if (!new RegExp(`<${binding}(?:[\\s/>])`).test(markup)) {
    return;
  }
  const roles = evidence.roles.get(target) ?? new Set(inferFolderRole(target));
  // A page wrapped by one imported component gives layout evidence even in an arbitrarily named folder.
  const wrapsPage = isWithin(evidence.pages, importer) && markup.trimStart().startsWith(`<${binding}`) && markup.trimEnd().endsWith(`</${binding}>`);
  roles.add(/Layout\.astro$/.test(target) || wrapsPage || roles.has('layouts') ? 'layouts' : 'components');
  evidence.roles.set(target, roles);
}
