// Discovering and resolving CSS `@import` targets across workspace packages and installed UI libraries.
//
// Workspace stylesheets (declared monorepo sibling packages) stay editable in place within the
// enclosing workspace root. Installed library stylesheets under `node_modules` are strictly read-only
// defaults: editing a library variable writes a local override into the importing project stylesheet.
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { assert } from '../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';
import { toRecord } from '../../shared/core/record';
import { isPathDescendant, isPathWithin } from '../lib/platform';
import { findEnclosingWorkspace, findWorkspacePackages, type WorkspacePackage } from './workspaceAstro';

export const CSS_IMPORT_LIMITS = {
  /** Maximum imported stylesheets discovered per project scan. */
  importsMax: 256,
  /** Maximum `@import` chain depth followed from a local stylesheet. */
  depthMax: 4,
  /** Maximum size in bytes of an imported stylesheet read for discovery. */
  fileBytesMax: 512 * 1024,
  /** Maximum size in bytes of a package.json manifest read during export resolution. */
  packageJsonBytesMax: 128 * 1024,
  /** Maximum parent directory hops checked when locating `node_modules`. */
  ancestorHopsMax: 16,
  /** Maximum nesting depth inside conditional `package.json#exports` objects. */
  exportConditionDepthMax: 4,
} as const satisfies Record<string, number>;

export const LIBRARY_FILE_PREFIX = 'library:';

// Utility framework core engines emit hundreds of low-level palette/utility tokens that belong to the
// CSS framework rather than a component library's semantic design tokens.
const EXCLUDED_LIBRARY_PACKAGES = new Set(['tailwindcss', 'tw-animate-css', 'tailwindcss-animate']);
const EXPORT_CONDITION_PRIORITY = ['style', 'default', 'import'] as const;

export interface ImportedStylesheet {
  readonly kind: 'workspace' | 'library';
  /** Canonical path on disk. */
  readonly absolutePath: string;
  /** Stable identifier stored as `file.rel` in the Variables model. */
  readonly rel: string;
  /** Human-readable file label shown in the Variables sidebar. */
  readonly displayName: string;
  /** Project-relative POSIX path to the local stylesheet that imported this file. */
  readonly importerRel: string;
}

export interface LibrarySourceMatch {
  readonly absolutePath: string;
  readonly importerRel: string;
}

interface ImportQueueItem {
  readonly kind: 'local' | 'workspace' | 'library';
  readonly absolutePath: string;
  readonly importerRel: string;
  readonly depth: number;
  readonly packageName?: string;
  readonly packageRealRoot?: string;
}

export function isLibraryVariableFile(file: string): boolean {
  return file.startsWith(LIBRARY_FILE_PREFIX);
}

/**
 * Follows `@import` rules from `localStylesheets` to discover shared workspace CSS files and installed
 * library default stylesheets (`@heroui/styles`, design-token packages, etc.). Never follows symlinks
 * outside the enclosing workspace or package boundary, and stays bounded in depth, count, and bytes.
 */
export function discoverImportedStylesheets(projectPath: string, localStylesheets: readonly string[]): readonly ImportedStylesheet[] {
  if (!path.isAbsolute(projectPath) || localStylesheets.length === 0) {
    return [];
  }
  const realProject = realDirectory(projectPath);
  if (realProject === undefined) {
    return [];
  }
  const workspace = findEnclosingWorkspace(projectPath);
  const realWorkspace = workspace === undefined ? undefined : realDirectory(workspace.workspaceRoot);
  const workspacePackages = workspace === undefined ? [] : findWorkspacePackages(workspace.workspaceRoot);
  const workspaceByName = new Map<string, WorkspacePackage>();
  for (const entry of workspacePackages) {
    workspaceByName.set(entry.name, entry);
  }
  const workspaceRealRoots = workspacePackages.flatMap((entry) => {
    const resolved = realDirectory(entry.packagePath);
    return resolved === undefined ? [] : [{ entry, realRoot: resolved }];
  });

  const visited = new Set<string>();
  const queue: ImportQueueItem[] = [];
  for (const localFile of localStylesheets) {
    const realFile = realCssFile(localFile);
    if (realFile === undefined || visited.has(realFile)) {
      continue;
    }
    visited.add(realFile);
    const importerRel = toPosix(path.relative(projectPath, localFile));
    if (importerRel.length === 0 || importerRel.startsWith('..') || path.isAbsolute(importerRel)) {
      continue;
    }
    queue.push({ kind: 'local', absolutePath: realFile, importerRel, depth: 0 });
  }

  const discovered: ImportedStylesheet[] = [];
  let cursor = 0;
  while (cursor < queue.length && discovered.length < CSS_IMPORT_LIMITS.importsMax) {
    const current = queue[cursor];
    cursor += 1;
    if (current === undefined || current.depth >= CSS_IMPORT_LIMITS.depthMax) {
      continue;
    }
    const text = readSmallCss(current.absolutePath);
    if (text === undefined) {
      continue;
    }
    for (const specifier of extractImportSpecifiers(text)) {
      if (discovered.length >= CSS_IMPORT_LIMITS.importsMax) {
        break;
      }
      const target = resolveImportTarget({
        specifier,
        current,
        projectPath,
        workspaceRoot: workspace?.workspaceRoot,
        realWorkspace,
        workspaceByName,
        workspaceRealRoots,
      });
      if (target === undefined || visited.has(target.realFile)) {
        continue;
      }
      visited.add(target.realFile);
      discovered.push(target.stylesheet);
      queue.push({
        kind: target.stylesheet.kind,
        absolutePath: target.realFile,
        importerRel: current.importerRel,
        depth: current.depth + 1,
        ...(target.packageName === undefined ? {} : { packageName: target.packageName }),
        ...(target.packageRealRoot === undefined ? {} : { packageRealRoot: target.packageRealRoot }),
      });
    }
  }
  assert(discovered.length <= CSS_IMPORT_LIMITS.importsMax, 'discoverImportedStylesheets: result stays bounded');
  return discovered;
}

/**
 * Resolves a variable file path that Stacki is permitted to mutate: either a file inside `projectPath`
 * (never under `node_modules`), or a `.css` file inside a declared sibling workspace package under the
 * enclosing monorepo root. Returns `undefined` for library defaults and any path outside those bounds.
 */
export function resolveEditableVariableFile(projectPath: string, file: string): string | undefined {
  if (file.length === 0 || isLibraryVariableFile(file)) {
    return undefined;
  }
  const abs = path.resolve(projectPath, file);
  if (hasNodeModulesSegment(abs)) {
    return undefined;
  }
  if (isContainedInDirectory(projectPath, abs)) {
    return abs;
  }
  return resolveEditableWorkspaceStyleFile(projectPath, abs);
}

/**
 * Resolves a `.css` file inside a declared sibling workspace package of `projectPath` so both edits
 * and undo/redo can read and restore shared workspace stylesheets without escaping the workspace root.
 */
export function resolveEditableWorkspaceStyleFile(projectPath: string, filePath: string): string | undefined {
  if (!path.isAbsolute(projectPath) || filePath.length === 0 || isLibraryVariableFile(filePath)) {
    return undefined;
  }
  const abs = path.resolve(filePath);
  if (!/\.css$/i.test(abs) || hasNodeModulesSegment(abs)) {
    return undefined;
  }
  const workspace = findEnclosingWorkspace(projectPath);
  if (workspace === undefined) {
    return undefined;
  }
  const realWorkspace = realDirectory(workspace.workspaceRoot);
  const realTarget = realCssFile(abs);
  if (realWorkspace === undefined || realTarget === undefined) {
    return undefined;
  }
  if (!isPathDescendant(realWorkspace, realTarget)) {
    return undefined;
  }
  const packages = findWorkspacePackages(workspace.workspaceRoot);
  for (const entry of packages) {
    const realPackage = realDirectory(entry.packagePath);
    if (realPackage !== undefined && isPathDescendant(realPackage, realTarget)) {
      return realTarget;
    }
  }
  return undefined;
}

/**
 * Finds the read-only disk file and local importing stylesheet for a `library:` variable file key.
 */
export function resolveLibrarySourceFile(projectPath: string, localStylesheets: readonly string[], file: string): LibrarySourceMatch | undefined {
  if (!isLibraryVariableFile(file)) {
    return undefined;
  }
  for (const entry of discoverImportedStylesheets(projectPath, localStylesheets)) {
    if (entry.kind === 'library' && entry.rel === file) {
      return { absolutePath: entry.absolutePath, importerRel: entry.importerRel };
    }
  }
  return undefined;
}

interface ResolveTargetInput {
  readonly specifier: string;
  readonly current: ImportQueueItem;
  readonly projectPath: string;
  readonly workspaceRoot: string | undefined;
  readonly realWorkspace: string | undefined;
  readonly workspaceByName: ReadonlyMap<string, WorkspacePackage>;
  readonly workspaceRealRoots: ReadonlyArray<{ readonly entry: WorkspacePackage; readonly realRoot: string }>;
}

interface ResolvedTarget {
  readonly realFile: string;
  readonly stylesheet: ImportedStylesheet;
  readonly packageName?: string;
  readonly packageRealRoot?: string;
}

function resolveImportTarget(input: ResolveTargetInput): ResolvedTarget | undefined {
  const { specifier, current, projectPath, workspaceRoot, realWorkspace, workspaceByName, workspaceRealRoots } = input;
  if (specifier.startsWith('.')) {
    return resolveRelativeImport(specifier, current, projectPath, realWorkspace, workspaceRealRoots);
  }
  const parsed = splitPackageSpecifier(specifier);
  if (parsed === undefined || EXCLUDED_LIBRARY_PACKAGES.has(parsed.packageName)) {
    return undefined;
  }
  const workspacePkg = workspaceByName.get(parsed.packageName);
  if (workspacePkg !== undefined && realWorkspace !== undefined) {
    const resolved = resolvePackageCssEntry(workspacePkg.packagePath, parsed.subpath);
    if (resolved === undefined || hasNodeModulesSegment(resolved) || !isPathDescendant(realWorkspace, resolved)) {
      return undefined;
    }
    const packageRealRoot = realDirectory(workspacePkg.packagePath);
    return {
      realFile: resolved,
      packageName: workspacePkg.name,
      ...(packageRealRoot === undefined ? {} : { packageRealRoot }),
      stylesheet: {
        kind: 'workspace',
        absolutePath: resolved,
        rel: toPosix(path.relative(projectPath, resolved)),
        displayName: `${workspacePkg.name}/${path.basename(resolved)}`,
        importerRel: current.importerRel,
      },
    };
  }
  const packageDirectory = findInstalledPackageDirectory(projectPath, workspaceRoot, parsed.packageName);
  if (packageDirectory === undefined) {
    return undefined;
  }
  const packageRealRoot = realDirectory(packageDirectory);
  if (packageRealRoot === undefined) {
    return undefined;
  }
  const resolved = resolvePackageCssEntry(packageRealRoot, parsed.subpath);
  if (resolved === undefined || !isPathDescendant(packageRealRoot, resolved)) {
    return undefined;
  }
  const subpathInPkg = toPosix(path.relative(packageRealRoot, resolved));
  return {
    realFile: resolved,
    packageName: parsed.packageName,
    packageRealRoot,
    stylesheet: {
      kind: 'library',
      absolutePath: resolved,
      rel: `${LIBRARY_FILE_PREFIX}${parsed.packageName}/${subpathInPkg}`,
      displayName: `${parsed.packageName} · ${path.basename(resolved)}`,
      importerRel: current.importerRel,
    },
  };
}

function resolveRelativeImport(
  specifier: string,
  current: ImportQueueItem,
  projectPath: string,
  realWorkspace: string | undefined,
  workspaceRealRoots: ReadonlyArray<{ readonly entry: WorkspacePackage; readonly realRoot: string }>,
): ResolvedTarget | undefined {
  const candidate = path.resolve(path.dirname(current.absolutePath), specifier);
  const realFile = realCssFile(candidate) ?? realCssFile(`${candidate}.css`);
  if (realFile === undefined) {
    return undefined;
  }
  if (current.kind === 'library') {
    if (current.packageName === undefined || current.packageRealRoot === undefined) {
      return undefined;
    }
    if (!isPathDescendant(current.packageRealRoot, realFile)) {
      return undefined;
    }
    const subpathInPkg = toPosix(path.relative(current.packageRealRoot, realFile));
    return {
      realFile,
      packageName: current.packageName,
      packageRealRoot: current.packageRealRoot,
      stylesheet: {
        kind: 'library',
        absolutePath: realFile,
        rel: `${LIBRARY_FILE_PREFIX}${current.packageName}/${subpathInPkg}`,
        displayName: `${current.packageName} · ${path.basename(realFile)}`,
        importerRel: current.importerRel,
      },
    };
  }
  if (realWorkspace === undefined || hasNodeModulesSegment(realFile) || !isPathDescendant(realWorkspace, realFile)) {
    return undefined;
  }
  // Ignore relative imports that stay inside the open project; `stylesheetsSliced` already reads them.
  const realProject = realDirectory(projectPath);
  if (realProject !== undefined && isPathDescendant(realProject, realFile)) {
    return undefined;
  }
  const owner = workspaceRealRoots.find((candidatePkg) => isPathDescendant(candidatePkg.realRoot, realFile));
  if (owner === undefined) {
    return undefined;
  }
  return {
    realFile,
    packageName: owner.entry.name,
    packageRealRoot: owner.realRoot,
    stylesheet: {
      kind: 'workspace',
      absolutePath: realFile,
      rel: toPosix(path.relative(projectPath, realFile)),
      displayName: `${owner.entry.name}/${path.basename(realFile)}`,
      importerRel: current.importerRel,
    },
  };
}

function extractImportSpecifiers(cssText: string): readonly string[] {
  const specifiers: string[] = [];
  let root: postcss.Root;
  try {
    root = postcss.parse(cssText);
  } catch {
    return specifiers;
  }
  root.walkAtRules('import', (rule) => {
    if (specifiers.length >= CSS_IMPORT_LIMITS.importsMax) {
      return;
    }
    const parsed = parseImportSpecifier(rule.params);
    if (parsed !== undefined) {
      specifiers.push(parsed);
    }
  });
  // Traverse theme/token/variable imports ahead of component barrels so design tokens are never crowded out.
  specifiers.sort((left, right) => importPriority(left) - importPriority(right));
  return specifiers;
}

function importPriority(specifier: string): number {
  return /(?:theme|token|variable)/i.test(specifier) ? 0 : 1;
}

function parseImportSpecifier(params: string): string | undefined {
  const trimmed = params.trim();
  const urlMatch = trimmed.match(/^url\(\s*(?:"([^"]+)"|'([^']+)'|([^)\s]+))\s*\)/i);
  const quotedMatch = urlMatch ? undefined : trimmed.match(/^(?:"([^"]+)"|'([^']+)')/);
  const raw = (urlMatch?.[1] ?? urlMatch?.[2] ?? urlMatch?.[3] ?? quotedMatch?.[1] ?? quotedMatch?.[2] ?? '').trim();
  if (raw.length === 0 || raw.length > BOUNDARY_LIMITS.pathLengthMax) {
    return undefined;
  }
  if (/^(?:https?:|data:|\/\/)/i.test(raw)) {
    return undefined;
  }
  return raw;
}

function splitPackageSpecifier(specifier: string): { readonly packageName: string; readonly subpath: string } | undefined {
  if (specifier.startsWith('/') || specifier.includes('\\') || specifier.includes('\0')) {
    return undefined;
  }
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    const scope = parts[0];
    const pkg = parts[1];
    if (!scope || !pkg) {
      return undefined;
    }
    const rest = parts.slice(2).join('/');
    return { packageName: `${scope}/${pkg}`, subpath: rest.length === 0 ? '.' : `./${rest}` };
  }
  const pkg = parts[0];
  if (!pkg) {
    return undefined;
  }
  const rest = parts.slice(1).join('/');
  return { packageName: pkg, subpath: rest.length === 0 ? '.' : `./${rest}` };
}

function findInstalledPackageDirectory(projectPath: string, workspaceRoot: string | undefined, packageName: string): string | undefined {
  const realLimit = realDirectory(workspaceRoot ?? projectPath);
  const segments = packageName.split('/');
  let current = path.resolve(projectPath);
  for (let hop = 0; hop < CSS_IMPORT_LIMITS.ancestorHopsMax; hop += 1) {
    const candidate = path.join(current, 'node_modules', ...segments);
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Keep climbing to the workspace root for hoisted pnpm/yarn/npm dependencies.
    }
    const realCurrent = realDirectory(current);
    if (realLimit !== undefined && realCurrent === realLimit) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

function resolvePackageCssEntry(packageRoot: string, subpath: string): string | undefined {
  const realRoot = realDirectory(packageRoot);
  if (realRoot === undefined) {
    return undefined;
  }
  const manifest = readPackageManifest(realRoot);
  if (manifest !== undefined) {
    const exported = matchPackageExport(manifest['exports'], subpath);
    if (exported !== undefined) {
      const target = realCssFile(path.resolve(realRoot, exported));
      if (target !== undefined && isPathDescendant(realRoot, target)) {
        return target;
      }
    }
    if (subpath === '.') {
      for (const field of ['style', 'main'] as const) {
        const value = manifest[field];
        if (typeof value === 'string' && /\.css$/i.test(value)) {
          const target = realCssFile(path.resolve(realRoot, value));
          if (target !== undefined && isPathDescendant(realRoot, target)) {
            return target;
          }
        }
      }
    }
  }
  if (subpath !== '.') {
    const clean = subpath.replace(/^\.\//, '');
    const direct = realCssFile(path.resolve(realRoot, clean)) ?? realCssFile(path.resolve(realRoot, `${clean}.css`));
    if (direct !== undefined && isPathDescendant(realRoot, direct)) {
      return direct;
    }
  }
  return undefined;
}

function matchPackageExport(exportsField: unknown, subpath: string): string | undefined {
  if (typeof exportsField === 'string') {
    return subpath === '.' ? exportsField : undefined;
  }
  const table = toRecord(exportsField);
  if (table === undefined) {
    return undefined;
  }
  if (subpath in table) {
    return pickExportLeaf(table[subpath], 0);
  }
  // Support conditional root exports like `{ "style": "./dist/index.css" }` when `subpath === '.'`.
  if (subpath === '.' && !Object.keys(table).some((key) => key.startsWith('.'))) {
    return pickExportLeaf(table, 0);
  }
  for (const [pattern, rawTarget] of Object.entries(table)) {
    const star = pattern.indexOf('*');
    if (star === -1 || pattern.indexOf('*', star + 1) !== -1) {
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) {
      continue;
    }
    const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
    if (matched.includes('..')) {
      continue;
    }
    const leaf = pickExportLeaf(rawTarget, 0);
    if (leaf !== undefined) {
      return leaf.replace('*', matched);
    }
  }
  return undefined;
}

function pickExportLeaf(value: unknown, depth: number): string | undefined {
  if (depth > CSS_IMPORT_LIMITS.exportConditionDepthMax) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  const branch = toRecord(value);
  if (branch === undefined) {
    return undefined;
  }
  for (const key of EXPORT_CONDITION_PRIORITY) {
    if (key in branch) {
      const picked = pickExportLeaf(branch[key], depth + 1);
      if (picked !== undefined) {
        return picked;
      }
    }
  }
  return undefined;
}

function readPackageManifest(directory: string): Readonly<Record<string, unknown>> | undefined {
  const file = path.join(directory, 'package.json');
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > CSS_IMPORT_LIMITS.packageJsonBytesMax) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return toRecord(parsed);
  } catch {
    return undefined;
  }
}

function readSmallCss(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > CSS_IMPORT_LIMITS.fileBytesMax) {
      return undefined;
    }
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function realDirectory(directory: string): string | undefined {
  try {
    const resolved = fs.realpathSync(directory);
    return fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function realCssFile(file: string): string | undefined {
  if (!/\.css$/i.test(file)) {
    return undefined;
  }
  try {
    const resolved = fs.realpathSync(file);
    return fs.statSync(resolved).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isContainedInDirectory(root: string, target: string): boolean {
  const realRoot = realDirectory(root);
  if (realRoot === undefined) {
    return isPathWithin(root, target);
  }
  try {
    return isPathWithin(realRoot, fs.realpathSync(target));
  } catch {
    // Allow non-existent paths when their lexical path stays strictly inside `root`.
    return isPathWithin(root, target);
  }
}

function hasNodeModulesSegment(filePath: string): boolean {
  return filePath.split(path.sep).includes('node_modules');
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}
