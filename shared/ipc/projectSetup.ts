// Folder setup reports only project-owned files. Dependencies and runtime routes are outside the inventory.
import { assert } from '../core/assert';
import { boolean, count, digest, object, optional, pathText, record, text } from '../core/boundary';
import { parseAbsolutePath } from './astroCopy';
import { toArray } from '../core/record';
import { err, ok, type Result } from '../core/result';
import { PROJECT_FOLDER_LIMITS, folderChoiceProblem, parseProjectFolder } from '../properties/projectFolders';

export const PROJECT_SETUP_ENTRIES_MAX = 20_000;
export const PROJECT_SETUP_EXAMPLES_MAX = 3;
export const PROJECT_SETUP_KINDS = ['components', 'layouts'] as const;
export type ProjectSetupKind = (typeof PROJECT_SETUP_KINDS)[number];

export interface ProjectSetupSuggestion {
  readonly kind: ProjectSetupKind;
  readonly folders: readonly string[];
  // Both editors count their whole project-owned component and layout inventory.
  readonly desktopBefore: number;
  readonly desktopAfter: number;
  readonly studioBefore: number;
  readonly studioAfter: number;
  readonly desktopAdded: readonly string[];
  readonly studioAdded: readonly string[];
  readonly studioRemoved: readonly string[];
}

export interface ProjectSetupReport {
  readonly revision: string;
  readonly pagesFolder: string;
  readonly pagesSource: 'default' | 'literal' | 'unverified';
  readonly desktopPages: number;
  readonly studioPages: number;
  readonly incomplete: boolean;
  readonly settings: 'editable' | 'unavailable';
  readonly suggestions: readonly ProjectSetupSuggestion[];
}

export const parseProjectSetupScan = object({ projectPath: parseAbsolutePath, permission: optional(parseScanPermission) });
export const parseProjectSetupApply = object({ projectPath: parseAbsolutePath, revision: digest, kinds: parseKinds });
export type ProjectSetupScan = ReturnType<typeof parseProjectSetupScan>;

function parseScanPermission(input: unknown): 'confirm-open' {
  if (input === 'confirm-open') {
    return input;
  }
  throw new Error('Unknown project setup permission request');
}

export function parseProjectSetupResult(input: unknown): Result<ProjectSetupReport> {
  const value = record(input);
  if (boolean(value['ok'])) {
    return ok(parseReport(value['value']));
  }
  return err(object({ code: text, message: text })(value['error']));
}

function parseReport(input: unknown): ProjectSetupReport {
  const report = object({
    revision: digest,
    pagesFolder: parsePagesFolder,
    pagesSource,
    desktopPages: discoveryCount,
    studioPages: discoveryCount,
    incomplete: boolean,
    settings,
    suggestions: parseSuggestions,
  })(input);
  if (report.suggestions.length > 0) {
    if (report.incomplete || report.settings === 'unavailable' || report.pagesSource === 'unverified') {
      throw new Error('Project setup suggestions require a complete report and editable settings');
    }
  }
  assert(report.desktopPages <= PROJECT_SETUP_ENTRIES_MAX, 'Desktop page count must stay within setup limit');
  assert(report.studioPages <= PROJECT_SETUP_ENTRIES_MAX, 'Studio page count must stay within setup limit');
  return report;
}

function parsePagesFolder(input: unknown): string {
  const folder = pathText(input);
  if (!folder.endsWith('/pages')) {
    throw new Error('Expected a project pages folder');
  }
  // The source path is bounded by the folder contract. Astro appends one more segment.
  parseProjectFolder(folder.slice(0, -'/pages'.length));
  assert(folder.endsWith('/pages'), 'Pages folder must keep its /pages suffix');
  return folder;
}

function pagesSource(input: unknown): ProjectSetupReport['pagesSource'] {
  if (input === 'default' || input === 'literal' || input === 'unverified') {
    return input;
  }
  throw new Error('Unknown project pages source');
}

function settings(input: unknown): ProjectSetupReport['settings'] {
  if (input === 'editable' || input === 'unavailable') {
    return input;
  }
  throw new Error('Unknown project setup settings status');
}

function discoveryCount(input: unknown): number {
  const value = count(input);
  if (value > PROJECT_SETUP_ENTRIES_MAX) {
    throw new Error('Project setup discovery count exceeds limit');
  }
  assert(Number.isSafeInteger(value), 'Discovery count must be a safe integer');
  return value;
}

function parseKind(input: unknown): ProjectSetupKind {
  if (input === 'components' || input === 'layouts') {
    return input;
  }
  throw new Error('Unknown project setup folder kind');
}

function parseKinds(input: unknown): readonly ProjectSetupKind[] {
  const kinds = boundedArray(input, PROJECT_SETUP_KINDS.length).map(parseKind);
  assertUniqueKinds(kinds);
  assert(kinds.length <= PROJECT_SETUP_KINDS.length, 'Project setup kinds must not exceed known kinds');
  return kinds;
}

function parseSuggestions(input: unknown): readonly ProjectSetupSuggestion[] {
  const suggestions = boundedArray(input, PROJECT_SETUP_KINDS.length).map(parseSuggestion);
  assertUniqueKinds(suggestions.map(({ kind }) => kind));
  assert(suggestions.length <= PROJECT_SETUP_KINDS.length, 'Project setup suggestions must not exceed known kinds');
  return suggestions;
}

function parseSuggestion(input: unknown): ProjectSetupSuggestion {
  const suggestion = object({
    kind: parseKind,
    folders: (value) => boundedArray(value, PROJECT_FOLDER_LIMITS.foldersPerKindMax).map(parseProjectFolder),
    desktopBefore: discoveryCount,
    desktopAfter: discoveryCount,
    studioBefore: discoveryCount,
    studioAfter: discoveryCount,
    desktopAdded: parseCatalogExamples,
    studioAdded: parseCatalogExamples,
    studioRemoved: parseCatalogExamples,
  })(input);
  const accepted: string[] = [];
  for (const folder of suggestion.folders) {
    const problem = folderChoiceProblem(suggestion.kind, accepted, folder);
    if (problem !== undefined) {
      throw new Error(problem);
    }
    accepted.push(folder);
  }
  if (accepted.length === 0) {
    throw new Error('Expected suggested project folders');
  }
  assert(accepted.length === suggestion.folders.length, 'Accepted folders must match suggestion folders');
  assert(accepted.length <= PROJECT_FOLDER_LIMITS.foldersPerKindMax, 'Suggested folders must stay within limit');
  return suggestion;
}

function parseCatalogExamples(input: unknown): readonly string[] {
  const examples = boundedArray(input, PROJECT_SETUP_EXAMPLES_MAX).map((value) => {
    const file = pathText(value);
    if (!(file.startsWith('src/') || file.startsWith('public/')) || !file.endsWith('.astro') || /(?:^|\/)\.{0,2}(?:\/|$)/.test(file)) {
      throw new Error('Expected a project-relative Astro catalog file');
    }
    return file;
  });
  assert(examples.length <= PROJECT_SETUP_EXAMPLES_MAX, 'Catalog examples must stay within limit');
  return examples;
}

function boundedArray(input: unknown, maximum: number): readonly unknown[] {
  assert(Number.isSafeInteger(maximum), 'Bounded array maximum must be a safe integer');
  assert(maximum >= 0, 'Bounded array maximum must be non-negative');
  const values = toArray(input);
  if (values === undefined || values.length > maximum) {
    throw new Error('Invalid project setup list');
  }
  return values;
}

function assertUniqueKinds(kinds: readonly ProjectSetupKind[]): void {
  if (new Set(kinds).size !== kinds.length) {
    throw new Error('Repeated project folder kind');
  }
}
