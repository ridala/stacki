// Making an Astro copy of a plain website folder: the contract of `project:openSiteDialog` (pick a
// folder and say what it is), `project:checkAstroCopy` (may a copy go here, under this name) and
// `project:createAstroCopy` (make it). The Welcome screen's "Open from folder" uses all three.
//
// Why a copy: a folder of .html, .css and .js files is not an Astro project, and turning it into one
// in place would move every page. The original stays untouched; the copy is a sibling by default,
// named `<folder>-astro`.
//
// Both sides parse with these functions: main checks every request before it touches the disk, and
// the renderer checks every reply before a component sees it. A path is absolute and normalized; a
// name is one folder name, never a path.
import { assert } from '../core/assert';
import { boolean, count, digest, list, object, optional, pathText, record, text } from '../core/boundary';
import { toArray } from '../core/record';
import { err, ok, type Result } from '../core/result';
import { PACKAGE_MANAGERS, parseCreatePackageManager, type CreatePackageManager, type PackageManager } from '../properties/packageManager';
import { PROJECT_FOLDER_LIMITS, folderChoiceProblem, parseProjectFolder } from '../properties/projectFolders';

export const ASTRO_COPY_LIMITS = {
  /** UTF-8 bytes in one folder name: the name limit of APFS, ext4 and NTFS alike. */
  nameBytesMax: 255,
  /** Paths a reply lists by name (pages kept as plain files, entries left out); the rest are only counted. */
  reportPathsMax: 50,
} as const satisfies Record<string, number>;

/** What the default name adds to the picked folder's name. */
export const ASTRO_COPY_SUFFIX = '-astro';

/** Why a name or a place cannot hold the copy. Each code is a field's error look and, on submit, one toast. */
export const ASTRO_COPY_TARGET_PROBLEMS = [
  'name-empty',
  'name-invalid',
  'target-exists',
  'location-missing',
  'location-unwritable',
  'inside-original',
] as const;
export type AstroCopyTargetProblem = (typeof ASTRO_COPY_TARGET_PROBLEMS)[number];

/** A copy that could not be made. The original folder is untouched in every case, and nothing is left at the target. */
export type AstroCopyFailure =
  | { readonly code: AstroCopyTargetProblem }
  | { readonly code: 'not-plain-website' }
  | { readonly code: 'too-many-files'; readonly limit: number }
  | { readonly code: 'too-many-bytes'; readonly limit: number }
  | { readonly code: 'file-too-large'; readonly limit: number; readonly file: string }
  | { readonly code: 'package-manager-missing'; readonly manager: PackageManager }
  | { readonly code: 'copy-failed'; readonly detail: string };

export interface AstroCopyRequest {
  /** The plain website folder, which is only read. */
  readonly sourcePath: string;
  /** The folder the copy goes in. */
  readonly parentPath: string;
  /** The copy's own folder name. */
  readonly name: string;
}

/** What the picked folder turned out to be. */
export type SiteFolderChoice =
  | { readonly kind: 'canceled' }
  | { readonly kind: 'astro'; readonly projectPath: string }
  | {
      readonly kind: 'plainWebsite';
      readonly sourcePath: string;
      /** The picked folder's parent: where the copy goes unless the person chooses elsewhere. */
      readonly parentPath: string;
      /** `<folder>-astro`, the suggested name. */
      readonly name: string;
      /** The home folder, so a location can be shown as `~/…`. */
      readonly homePath: string;
    }
  | { readonly kind: 'notWebsite'; readonly folderPath: string };

export type AstroCopyCheck = Result<{ readonly targetPath: string }, AstroCopyTargetProblem>;

/** How the new project's install went. A failed install keeps the copy: opening it installs again. */
export type AstroCopyInstall = { readonly kind: 'done' } | { readonly kind: 'failed'; readonly detail: string };

export interface AstroCopyCreated {
  readonly projectPath: string;
  /** Pages that became .astro files under src/pages. */
  readonly pageCount: number;
  /** Files that went under public/. */
  readonly assetCount: number;
  /** Pages that stay plain .html files under public/ so their addresses keep working (Astro cannot route them), relative to the original. */
  readonly keptAsFiles: readonly string[];
  readonly keptAsFilesCount: number;
  /** Entries of the original left out of the copy (installed packages, Git data, hidden files, links outside the folder). */
  readonly skippedCount: number;
  readonly install: AstroCopyInstall;
}

export type AstroCopyReply = Result<AstroCopyCreated, AstroCopyFailure>;

// Characters no folder name may hold on at least one of macOS, Windows and Linux: separators, the
// Windows-reserved set and control characters. A name that is valid everywhere moves between machines.
const NAME_FORBIDDEN = /[/\\<>:"|?*\u0000-\u001f\u007f]/;
// Windows refuses these as names whatever the extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const UTF8 = new TextEncoder();

/** Why `name` cannot be the copy's folder name, or undefined when it can. The renderer and main both decide with this. */
export function astroCopyNameProblem(name: string): 'name-empty' | 'name-invalid' | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return 'name-empty';
  }
  if (trimmed !== name) {
    // A leading or trailing space is invisible in the field and in Finder; refuse it rather than strip it silently.
    return 'name-invalid';
  }
  if (NAME_FORBIDDEN.test(name)) {
    return 'name-invalid';
  }
  // A leading dot hides the folder; a trailing one is dropped by Windows.
  if (name.startsWith('.') || name.endsWith('.')) {
    return 'name-invalid';
  }
  if (WINDOWS_RESERVED.test(name)) {
    return 'name-invalid';
  }
  if (UTF8.encode(name).length > ASTRO_COPY_LIMITS.nameBytesMax) {
    return 'name-invalid';
  }
  return undefined;
}

/** `<folder>-astro`, shortened (never mid-character) so it stays within the name limit. */
export function defaultAstroCopyName(folderName: string): string {
  assert(folderName.length > 0, 'defaultAstroCopyName: the folder has a name');
  const characters = [...folderName];
  const suffixBytes = UTF8.encode(ASTRO_COPY_SUFFIX).length;
  let stem = '';
  for (const character of characters) {
    if (UTF8.encode(stem + character).length + suffixBytes > ASTRO_COPY_LIMITS.nameBytesMax) {
      break;
    }
    stem += character;
  }
  const name = stem + ASTRO_COPY_SUFFIX;
  assert(UTF8.encode(name).length <= ASTRO_COPY_LIMITS.nameBytesMax, 'defaultAstroCopyName: the name fits');
  assert(name.endsWith(ASTRO_COPY_SUFFIX), 'defaultAstroCopyName: the suffix is kept');
  return name;
}

/**
 * A location as the dialog shows it: the home folder as `~`, and only the last few folders of a long
 * path behind `…`. The full path is the row's tooltip.
 */
export function shortenLocation(location: string, homePath: string, segmentsMax = 3): string {
  assert(segmentsMax > 0, 'shortenLocation: at least one folder is shown');
  const separator = location.includes('\\') && !location.includes('/') ? '\\' : '/';
  let shown = location;
  let prefix = '';
  if (homePath.length > 0 && (location === homePath || location.startsWith(homePath + separator))) {
    shown = location.slice(homePath.length);
    prefix = '~';
  }
  const segments = shown.split(separator).filter((segment) => segment.length > 0);
  if (segments.length <= segmentsMax) {
    return prefix === '' ? location : prefix + shown;
  }
  return `…${separator}${segments.slice(-segmentsMax).join(separator)}`;
}

/**
 * An absolute, normalized path: rooted (`/…`, `C:\…` or `\\server\share\…`), no `.` or `..` folder, no
 * empty folder between separators and no separator at the end (other than a root's own).
 */
export function parseAbsolutePath(input: unknown): string {
  const value = pathText(input);
  const windowsDrive = /^[A-Za-z]:[\\/]/.test(value);
  const unc = value.startsWith('\\\\');
  if (!value.startsWith('/') && !windowsDrive && !unc) {
    throw new Error('Path: expected an absolute path');
  }
  const rest = unc ? value.slice(2) : windowsDrive ? value.slice(3) : value.slice(1);
  if (rest.length === 0) {
    if (unc) {
      throw new Error('Path: expected a server and share');
    }
    return value;
  }
  const segments = rest.split(/[\\/]/);
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error('Path: expected a normalized path');
    }
    if (segment === '.' || segment === '..') {
      throw new Error('Path: expected no . or .. folders');
    }
  }
  return value;
}

/** One folder name: what `astroCopyNameProblem` judges, bounded here so a huge string never reaches it. */
export function parseAstroCopyName(input: unknown): string {
  const value = text(input);
  if (value.length > ASTRO_COPY_LIMITS.nameBytesMax * 4) {
    throw new Error('Name: exceeds limit');
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error('Name: expected a folder name, not a path');
  }
  return value;
}

export function parseAstroCopyRequest(input: unknown): AstroCopyRequest {
  const fields = record(input);
  return {
    sourcePath: parseAbsolutePath(fields['sourcePath']),
    parentPath: parseAbsolutePath(fields['parentPath']),
    name: parseAstroCopyName(fields['name']),
  };
}

export function parseSiteFolderChoice(input: unknown): SiteFolderChoice {
  const fields = record(input);
  const kind = fields['kind'];
  switch (kind) {
    case 'canceled':
      return { kind };
    case 'astro':
      return { kind, projectPath: parseAbsolutePath(fields['projectPath']) };
    case 'plainWebsite': {
      const name = parseAstroCopyName(fields['name']);
      const homePath = pathText(fields['homePath']);
      return { kind, sourcePath: parseAbsolutePath(fields['sourcePath']), parentPath: parseAbsolutePath(fields['parentPath']), name, homePath };
    }
    case 'notWebsite':
      return { kind, folderPath: parseAbsolutePath(fields['folderPath']) };
    default:
      throw new Error('SiteFolderChoice.kind: unknown value');
  }
}

export function parseAstroCopyTargetProblem(input: unknown): AstroCopyTargetProblem {
  const problem = ASTRO_COPY_TARGET_PROBLEMS.find((known) => known === input);
  if (problem === undefined) {
    throw new Error('AstroCopy problem: unknown value');
  }
  return problem;
}

export function parseAstroCopyCheck(input: unknown): AstroCopyCheck {
  const fields = record(input);
  if (fields['ok'] === true) {
    const value = record(fields['value']);
    return ok({ targetPath: parseAbsolutePath(value['targetPath']) });
  }
  if (fields['ok'] !== false) {
    throw new Error('AstroCopyCheck.ok: expected a boolean');
  }
  return err(parseAstroCopyTargetProblem(fields['error']));
}

export function parseAstroCopyFailure(input: unknown): AstroCopyFailure {
  const fields = record(input);
  const code = fields['code'];
  switch (code) {
    case 'not-plain-website':
      return { code };
    case 'too-many-files':
    case 'too-many-bytes':
      return { code, limit: count(fields['limit']) };
    case 'file-too-large':
      return { code, limit: count(fields['limit']), file: pathText(fields['file']) };
    case 'package-manager-missing': {
      const manager = PACKAGE_MANAGERS.find((known) => known === fields['manager']);
      if (manager === undefined) {
        throw new Error('AstroCopyFailure.manager: unknown value');
      }
      return { code, manager };
    }
    case 'copy-failed':
      return { code, detail: text(fields['detail']) };
    default:
      return { code: parseAstroCopyTargetProblem(code) };
  }
}

function parseReportPaths(input: unknown): readonly string[] {
  const paths = list(pathText)(input);
  if (paths.length > ASTRO_COPY_LIMITS.reportPathsMax) {
    throw new Error('AstroCopyCreated: too many listed paths');
  }
  return paths;
}

function parseAstroCopyInstall(input: unknown): AstroCopyInstall {
  const fields = record(input);
  if (fields['kind'] === 'done') {
    return { kind: 'done' };
  }
  if (fields['kind'] === 'failed') {
    return { kind: 'failed', detail: text(fields['detail']) };
  }
  throw new Error('AstroCopyInstall.kind: unknown value');
}

export function parseAstroCopyCreated(input: unknown): AstroCopyCreated {
  const fields = record(input);
  const keptAsFiles = parseReportPaths(fields['keptAsFiles']);
  const keptAsFilesCount = count(fields['keptAsFilesCount']);
  if (keptAsFilesCount < keptAsFiles.length) {
    throw new Error('AstroCopyCreated.keptAsFilesCount: fewer than listed');
  }
  return {
    projectPath: parseAbsolutePath(fields['projectPath']),
    pageCount: count(fields['pageCount']),
    assetCount: count(fields['assetCount']),
    keptAsFiles,
    keptAsFilesCount,
    skippedCount: count(fields['skippedCount']),
    install: parseAstroCopyInstall(fields['install']),
  };
}

export function parseAstroCopyReply(input: unknown): AstroCopyReply {
  const fields = record(input);
  if (boolean(fields['ok'])) {
    return ok(parseAstroCopyCreated(fields['value']));
  }
  return err(parseAstroCopyFailure(fields['error']));
}

// Project folder setup, shadcn starter, and shadcn settings contracts live alongside Astro copy
// so Studio's vendored IPC surface stays within its release file target.
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

export const SHADCN_BASES = ['base', 'aria', 'radix'] as const;
export const SHADCN_ICON_LIBRARIES = ['lucide', 'tabler', 'hugeicons', 'phosphor', 'remixicon'] as const;
export const SHADCN_STYLES = ['vega', 'nova', 'maia', 'lyra', 'mira', 'luma', 'sera', 'rhea'] as const;
export type ShadcnBase = (typeof SHADCN_BASES)[number];
export type ShadcnIconLibrary = (typeof SHADCN_ICON_LIBRARIES)[number];
export type ShadcnStyle = (typeof SHADCN_STYLES)[number];

export interface ShadcnStarterOptions {
  readonly base: ShadcnBase;
  readonly style?: ShadcnStyle;
  readonly iconLibrary: ShadcnIconLibrary;
  readonly preset?: string;
  readonly pointer: boolean;
  readonly rtl: boolean;
}

export const SHADCN_STARTER_DEFAULTS = {
  base: 'base',
  style: 'nova',
  iconLibrary: 'lucide',
  pointer: false,
  rtl: false,
} as const satisfies ShadcnStarterOptions;

interface StarterLocation {
  readonly parentPath: string;
  readonly name: string;
  readonly packageManager?: CreatePackageManager;
}

export type StarterRequest = StarterLocation &
  (
    | { readonly starter?: 'lumos'; readonly shadcn?: never }
    | { readonly starter: 'heroui'; readonly shadcn?: never }
    | { readonly starter: 'shadcn'; readonly shadcn: ShadcnStarterOptions }
  );
export type ShadcnPresetReply = Result<{ readonly iconLibrary: ShadcnIconLibrary; readonly style: ShadcnStyle }, { readonly message: string }>;

export const SHADCN_PRESET_CODE_LENGTH_MAX = 32;
const SITE_NAME_LENGTH_MAX = 128;

export function parseStarterRequest(input: unknown): StarterRequest {
  const fields = record(input);
  const starter = fields['starter'];
  switch (starter) {
    case 'shadcn':
      return { ...parseStarterLocation(fields), starter, shadcn: parseShadcnOptions(fields['shadcn']) };
    case 'heroui':
      if ('shadcn' in fields) {
        throw new Error('shadcn options require the shadcn starter.');
      }
      return { ...parseStarterLocation(fields), starter };
    case 'lumos':
    case undefined: {
      if (fields['shadcn'] !== undefined) {
        throw new Error('shadcn options require the shadcn starter.');
      }
      const location = parseLumosLocation(fields);
      return starter === undefined ? location : { ...location, starter };
    }
    default:
      throw new Error('Unknown site starter.');
  }
}

/** Checks the bare argument before it can reach a shell. The shadcn CLI validates the code itself. */
export function parseShadcnPresetCode(input: unknown): string {
  assert(SHADCN_PRESET_CODE_LENGTH_MAX > 0, 'Preset code limit must be positive');
  const code = text(input);
  if (code.length <= SHADCN_PRESET_CODE_LENGTH_MAX) {
    if (/^[ab][0-9A-Za-z]+$/.test(code)) {
      assert(code.length > 0, 'Validated preset code must be non-empty');
      return code;
    }
  }
  throw new Error('Enter a shadcn preset code.');
}

export const parseShadcnPresetRequest = object({ preset: parseShadcnPresetCode });

export function parseShadcnPresetReply(input: unknown): ShadcnPresetReply {
  const fields = record(input);
  if (boolean(fields['ok'])) {
    return ok(parseShadcnPresetSelection(fields['value']));
  }
  return err(parsePresetError(fields['error']));
}

const parseStarterLocation = object({
  parentPath: parseAbsolutePath,
  name: parseStarterName,
  packageManager: optional(parseCreatePackageManager),
});

const parseLumosLocation = object({ parentPath: pathText, name: text, packageManager: optional(parseCreatePackageManager) });

const parseShadcnOptions = object({
  base: parseShadcnBase,
  style: optional(parseShadcnStyle),
  iconLibrary: parseShadcnIconLibrary,
  preset: optional(parseShadcnPresetCode),
  pointer: boolean,
  rtl: boolean,
});

export const parseShadcnPresetSelection = object({ iconLibrary: parseShadcnIconLibrary, style: parseShadcnStyle });
export const parseShadcnIconSelection = object({ iconLibrary: parseShadcnIconLibrary });
const parsePresetError = object({ message: text });

export function parseStarterName(input: unknown): string {
  assert(SITE_NAME_LENGTH_MAX > 0, 'Site name limit must be positive');
  const name = text(input).trim();
  if (name.length <= SITE_NAME_LENGTH_MAX) {
    if (/^(?!-)(?!\.{1,2}$)[A-Za-z0-9._-]+$/.test(name)) {
      assert(name.length > 0, 'Validated starter name must be non-empty');
      return name;
    }
  }
  throw new Error('Use letters, numbers, dashes, dots or underscores for the folder name.');
}

function parseShadcnBase(input: unknown): ShadcnBase {
  const base = SHADCN_BASES.find((candidate) => candidate === input);
  if (base === undefined) {
    throw new Error('Choose a supported shadcn base.');
  }
  assert(SHADCN_BASES.includes(base), 'Parsed shadcn base must be in supported bases');
  return base;
}

function parseShadcnStyle(input: unknown): ShadcnStyle {
  const style = SHADCN_STYLES.find((candidate) => candidate === input);
  if (style === undefined) {
    throw new Error('Choose a supported shadcn style.');
  }
  assert(SHADCN_STYLES.includes(style), 'Parsed shadcn style must be in supported styles');
  return style;
}

function parseShadcnIconLibrary(input: unknown): ShadcnIconLibrary {
  const library = SHADCN_ICON_LIBRARIES.find((candidate) => candidate === input);
  if (library === undefined) {
    throw new Error('Choose a supported shadcn icon library.');
  }
  assert(SHADCN_ICON_LIBRARIES.includes(library), 'Parsed shadcn icon library must be in supported libraries');
  return library;
}

export const parseShadcnSettingsRequest = object({ projectPath: parseAbsolutePath });
export const parseShadcnSettingsChange = object({ projectPath: parseAbsolutePath, setting: parseShadcnSetting, enabled: boolean });
const parseShadcnSettingsValue = object({ pointer: boolean, rtl: boolean });
const parseShadcnSettingsError = object({ message: text });

export type ShadcnSettings = ReturnType<typeof parseShadcnSettingsValue>;
export type ShadcnSettingsChange = ReturnType<typeof parseShadcnSettingsChange>;
export type ShadcnSettingsReply = Result<ShadcnSettings | undefined, { readonly message: string }>;

export function parseShadcnSettingsReply(input: unknown): ShadcnSettingsReply {
  const fields = record(input);
  if (!boolean(fields['ok'])) {
    const error = parseShadcnSettingsError(fields['error']);
    assert(typeof error.message === 'string', 'Shadcn settings error must carry a message');
    return err(error);
  }
  const value = fields['value'] === undefined ? undefined : parseShadcnSettingsValue(fields['value']);
  if (value !== undefined) {
    assert(typeof value.pointer === 'boolean', 'Shadcn pointer setting must be boolean');
    assert(typeof value.rtl === 'boolean', 'Shadcn rtl setting must be boolean');
  }
  return ok(value);
}

function parseShadcnSetting(input: unknown): 'pointer' | 'rtl' {
  if (input === 'pointer' || input === 'rtl') {
    assert(input.length > 0, 'Shadcn setting key must be non-empty');
    return input;
  }
  throw new Error('Unknown shadcn setting.');
}
