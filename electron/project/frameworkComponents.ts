// Discovering non-Astro framework UI components (React, Vue, Svelte) in the project and its
// declared workspace packages, and generating clean on-demand `.astro` wrappers under the project's
// component folder without overwriting existing files.
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';
import { toRecord } from '../../shared/core/record';
import { err, ok, type Result } from '../../shared/core/result';
import type { FrameworkComponentKind, ScanFrameworkComponent } from '../../shared/properties/projectScan';
import { createProjectText } from '../documents/documentWrites';
import { isPathDescendant } from '../lib/platform';
import { projectFoldersFor } from '../lib/projectFolders';
import { findEnclosingWorkspace, findWorkspacePackages, readProjectDependencyNames, type WorkspacePackage } from './workspaceAstro';

export const FRAMEWORK_COMPONENT_LIMITS = {
  /** Maximum framework components listed in one project scan. */
  entriesMax: 160,
  /** Maximum directory depth walked inside a component folder. */
  depthMax: 6,
  /** Maximum size in bytes of a component source file inspected for exports. */
  sourceBytesMax: 256 * 1024,
  /** Maximum size in bytes of a workspace package.json inspected for exports. */
  manifestBytesMax: 128 * 1024,
} as const satisfies Record<string, number>;

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.astro', '.stacki', 'dist', 'build', 'coverage', '__tests__']);
const TEST_OR_STORY_FILE = /\.(?:test|spec|stories|story|d)\.[cm]?[jt]sx?$/i;
const VALID_COMPONENT_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
const RESERVED_ASTRO_NAMES = new Set(['Fragment', 'Astro', 'Slot', 'slot', 'script', 'style']);

export interface WrapFrameworkComponentInput {
  readonly projectPath: string;
  readonly name: string;
  readonly importPath: string;
  readonly exportKind: 'default' | 'named';
  readonly framework: FrameworkComponentKind;
}

export interface WrappedFrameworkComponent {
  readonly path: string;
  readonly rel: string;
  readonly name: string;
}

/**
 * Discovers React (`.tsx`/`.jsx`), Vue (`.vue`), and Svelte (`.svelte`) component files in the
 * project's component folders and in declared workspace dependency packages (such as `packages/ui`).
 * Never follows symlinks outside the project or workspace root, and marks any component that already
 * has a matching `.astro` wrapper.
 */
export function discoverFrameworkComponents(
  projectPath: string,
  componentFolders: readonly string[],
  existingAstroNames: ReadonlySet<string>,
): readonly ScanFrameworkComponent[] {
  if (!path.isAbsolute(projectPath)) {
    return [];
  }
  const realProject = realDirectory(projectPath);
  if (realProject === undefined) {
    return [];
  }
  const primaryFolder = componentFolders[0] ?? 'src/components';
  const primaryAbs = path.resolve(projectPath, primaryFolder);
  const discovered: ScanFrameworkComponent[] = [];
  const seenFiles = new Set<string>();

  for (const folder of componentFolders) {
    if (discovered.length >= FRAMEWORK_COMPONENT_LIMITS.entriesMax) {
      break;
    }
    const folderAbs = path.resolve(projectPath, folder);
    if (!isContainedRealDirectory(realProject, folderAbs)) {
      continue;
    }
    collectLocalComponents({
      projectPath,
      realProject,
      primaryAbs,
      directory: folderAbs,
      existingAstroNames,
      seenFiles,
      out: discovered,
      depth: 0,
    });
  }

  const workspace = findEnclosingWorkspace(projectPath);
  if (workspace !== undefined && discovered.length < FRAMEWORK_COMPONENT_LIMITS.entriesMax) {
    const realWorkspace = realDirectory(workspace.workspaceRoot);
    const dependencies = readProjectDependencyNames(projectPath);
    if (realWorkspace !== undefined && dependencies.size > 0) {
      const normalizedProject = path.resolve(projectPath);
      for (const pkg of findWorkspacePackages(workspace.workspaceRoot)) {
        if (discovered.length >= FRAMEWORK_COMPONENT_LIMITS.entriesMax) {
          break;
        }
        if (path.resolve(pkg.packagePath) === normalizedProject || !dependencies.has(pkg.name)) {
          continue;
        }
        collectWorkspacePackageComponents({
          pkg,
          realWorkspace,
          existingAstroNames,
          seenFiles,
          out: discovered,
        });
      }
    }
  }

  discovered.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : left.file.localeCompare(right.file)));
  assert(discovered.length <= FRAMEWORK_COMPONENT_LIMITS.entriesMax, 'discoverFrameworkComponents: result stays bounded');
  return discovered;
}

/**
 * Creates a clean minimal `.astro` wrapper inside the project's primary component folder so the
 * framework component becomes insertable from Stacki's Components palette. Refuses to overwrite any
 * existing file.
 */
export function wrapFrameworkComponent(input: WrapFrameworkComponentInput): Result<WrappedFrameworkComponent> {
  const { projectPath, name, importPath, exportKind, framework } = input;
  if (!path.isAbsolute(projectPath)) {
    return err({ code: 'invalid-project', message: 'Project path must be absolute.' });
  }
  if (!VALID_COMPONENT_NAME.test(name) || RESERVED_ASTRO_NAMES.has(name)) {
    return err({ code: 'invalid-name', message: `Component name "${name}" is not a valid Astro component name.` });
  }
  if (!isSafeImportSpecifier(importPath)) {
    return err({ code: 'invalid-import', message: 'Import specifier contains unsupported characters.' });
  }
  const componentFolders = projectFoldersFor(projectPath, 'components');
  const primaryFolder = componentFolders[0] ?? 'src/components';
  const targetDirectory = path.resolve(projectPath, primaryFolder);
  const targetPath = path.join(targetDirectory, `${name}.astro`);
  if (!isPathDescendant(path.resolve(projectPath), targetPath)) {
    return err({ code: 'outside-project', message: 'Wrapper target must stay inside the project.' });
  }
  if (fs.existsSync(targetPath)) {
    return err({ code: 'exists', message: `${toPosix(path.relative(projectPath, targetPath))} already exists.` });
  }
  const source = buildWrapperSource({ name, importPath, exportKind, framework });
  try {
    fs.mkdirSync(targetDirectory, { recursive: true });
    createProjectText(targetPath, source);
  } catch (error: unknown) {
    return err({ code: 'write-failed', message: error instanceof Error ? error.message : String(error) });
  }
  const rel = toPosix(path.relative(projectPath, targetPath));
  assert(fs.existsSync(targetPath), 'wrapFrameworkComponent: wrapper file exists after creation');
  return ok({ path: targetPath, rel, name });
}

function buildWrapperSource({
  name,
  importPath,
  exportKind,
}: {
  readonly name: string;
  readonly importPath: string;
  readonly exportKind: 'default' | 'named';
  readonly framework: FrameworkComponentKind;
}): string {
  const importLine = exportKind === 'named' ? `import { ${name} } from '${importPath}';` : `import ${name} from '${importPath}';`;
  // Hydrate React/Vue/Svelte islands on load so interactive controls respond immediately in Stacki preview.
  return `---\n${importLine}\n\nexport interface Props {\n  class?: string;\n}\n\nconst { class: className } = Astro.props;\n---\n\n<${name} client:load class={className} />\n`;
}

function isSafeImportSpecifier(specifier: string): boolean {
  if (specifier.length === 0 || specifier.length > BOUNDARY_LIMITS.pathLengthMax) {
    return false;
  }
  return !/['"`\\\r\n\0<>]/.test(specifier);
}

interface LocalCollectOptions {
  readonly projectPath: string;
  readonly realProject: string;
  readonly primaryAbs: string;
  readonly directory: string;
  readonly existingAstroNames: ReadonlySet<string>;
  readonly seenFiles: Set<string>;
  readonly out: ScanFrameworkComponent[];
  readonly depth: number;
}

function collectLocalComponents(options: LocalCollectOptions): void {
  if (options.depth > FRAMEWORK_COMPONENT_LIMITS.depthMax || options.out.length >= FRAMEWORK_COMPONENT_LIMITS.entriesMax) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(options.directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (options.out.length >= FRAMEWORK_COMPONENT_LIMITS.entriesMax) {
      break;
    }
    if (entry.name.startsWith('.') || entry.name.startsWith('_') || SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const full = path.join(options.directory, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      collectLocalComponents({ ...options, directory: full, depth: options.depth + 1 });
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const framework = frameworkForFilename(entry.name);
    if (framework === undefined || TEST_OR_STORY_FILE.test(entry.name)) {
      continue;
    }
    const realFile = realRegularFile(full);
    if (realFile === undefined || !isPathDescendant(options.realProject, realFile) || options.seenFiles.has(realFile)) {
      continue;
    }
    const detected = inspectComponentExport(realFile, entry.name, framework);
    if (detected === undefined) {
      continue;
    }
    options.seenFiles.add(realFile);
    const rel = toPosix(path.relative(options.projectPath, full));
    const importPath = relativeImportSpecifier(options.primaryAbs, full, framework);
    options.out.push({
      name: detected.name,
      file: rel,
      importPath,
      exportKind: detected.exportKind,
      framework,
      ...(options.existingAstroNames.has(detected.name.toLowerCase()) ? { wrapped: true } : {}),
    });
  }
}

function collectWorkspacePackageComponents({
  pkg,
  realWorkspace,
  existingAstroNames,
  seenFiles,
  out,
}: {
  readonly pkg: WorkspacePackage;
  readonly realWorkspace: string;
  readonly existingAstroNames: ReadonlySet<string>;
  readonly seenFiles: Set<string>;
  readonly out: ScanFrameworkComponent[];
}): void {
  const realPkg = realDirectory(pkg.packagePath);
  if (realPkg === undefined || !isPathDescendant(realWorkspace, realPkg)) {
    return;
  }
  const exportsMap = readPackageExports(realPkg);
  for (const sub of ['src/components', 'components'] as const) {
    const directory = path.join(realPkg, ...sub.split('/'));
    if (!isContainedRealDirectory(realPkg, directory)) {
      continue;
    }
    walkWorkspaceComponentDirectory({
      pkg,
      realPkg,
      exportsMap,
      directory,
      existingAstroNames,
      seenFiles,
      out,
      depth: 0,
    });
  }
}

function walkWorkspaceComponentDirectory({
  pkg,
  realPkg,
  exportsMap,
  directory,
  existingAstroNames,
  seenFiles,
  out,
  depth,
}: {
  readonly pkg: WorkspacePackage;
  readonly realPkg: string;
  readonly exportsMap: Readonly<Record<string, unknown>> | undefined;
  readonly directory: string;
  readonly existingAstroNames: ReadonlySet<string>;
  readonly seenFiles: Set<string>;
  readonly out: ScanFrameworkComponent[];
  readonly depth: number;
}): void {
  if (depth > FRAMEWORK_COMPONENT_LIMITS.depthMax || out.length >= FRAMEWORK_COMPONENT_LIMITS.entriesMax) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= FRAMEWORK_COMPONENT_LIMITS.entriesMax) {
      break;
    }
    if (entry.name.startsWith('.') || entry.name.startsWith('_') || SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      walkWorkspaceComponentDirectory({ pkg, realPkg, exportsMap, directory: full, existingAstroNames, seenFiles, out, depth: depth + 1 });
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const framework = frameworkForFilename(entry.name);
    if (framework === undefined || TEST_OR_STORY_FILE.test(entry.name)) {
      continue;
    }
    const realFile = realRegularFile(full);
    if (realFile === undefined || !isPathDescendant(realPkg, realFile) || seenFiles.has(realFile)) {
      continue;
    }
    const relInPkg = `./${toPosix(path.relative(realPkg, realFile))}`;
    const importPath = reversePackageExport(pkg.name, relInPkg, exportsMap);
    if (importPath === undefined) {
      continue;
    }
    const detected = inspectComponentExport(realFile, entry.name, framework);
    if (detected === undefined) {
      continue;
    }
    seenFiles.add(realFile);
    const relDisplay = `${pkg.relativePath}/${relInPkg.slice(2)}`;
    out.push({
      name: detected.name,
      file: relDisplay,
      importPath,
      exportKind: detected.exportKind,
      framework,
      packageName: pkg.name,
      ...(existingAstroNames.has(detected.name.toLowerCase()) ? { wrapped: true } : {}),
    });
  }
}

function frameworkForFilename(filename: string): FrameworkComponentKind | undefined {
  if (/\.(?:tsx|jsx)$/i.test(filename)) {
    return 'react';
  }
  if (/\.vue$/i.test(filename)) {
    return 'vue';
  }
  if (/\.svelte$/i.test(filename)) {
    return 'svelte';
  }
  return undefined;
}

function inspectComponentExport(
  filePath: string,
  filename: string,
  framework: FrameworkComponentKind,
): { readonly name: string; readonly exportKind: 'default' | 'named' } | undefined {
  const stem = filename.replace(/\.(?:tsx|jsx|vue|svelte)$/i, '');
  if (/^index$/i.test(stem) || /^use[A-Z]/.test(stem)) {
    return undefined;
  }
  const stemName = toPascalCase(stem);
  if (framework === 'vue' || framework === 'svelte') {
    return VALID_COMPONENT_NAME.test(stemName) ? { name: stemName, exportKind: 'default' } : undefined;
  }
  const source = readSmallFile(filePath);
  if (source === undefined || !source.includes('<')) {
    return undefined;
  }
  // Check explicit default export first.
  const defaultNamed = source.match(/\bexport\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Z][A-Za-z0-9]*)\b/);
  if (defaultNamed?.[1] !== undefined && VALID_COMPONENT_NAME.test(defaultNamed[1])) {
    return { name: defaultNamed[1], exportKind: 'default' };
  }
  if (/\bexport\s+default\b/.test(source) && VALID_COMPONENT_NAME.test(stemName)) {
    return { name: stemName, exportKind: 'default' };
  }
  // Check named PascalCase component exports, preferring one matching the filename stem.
  const namedCandidates = collectNamedComponentExports(source);
  if (namedCandidates.length === 0) {
    return undefined;
  }
  const preferred = namedCandidates.find((candidate) => candidate.toLowerCase() === stemName.toLowerCase()) ?? namedCandidates[0];
  if (preferred === undefined || !VALID_COMPONENT_NAME.test(preferred)) {
    return undefined;
  }
  return { name: preferred, exportKind: 'named' };
}

function collectNamedComponentExports(source: string): readonly string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined): void => {
    if (candidate !== undefined && VALID_COMPONENT_NAME.test(candidate) && !RESERVED_ASTRO_NAMES.has(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      names.push(candidate);
    }
  };
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|class)\s+([A-Z][A-Za-z0-9]*)\b/g)) {
    add(match[1]);
  }
  for (const match of source.matchAll(/\bexport\s*\{([^}]{1,400})\}/g)) {
    const body = match[1] ?? '';
    for (const part of body.split(',')) {
      const cleaned = part.trim().replace(/^type\s+/, '');
      if (part.trim().startsWith('type ')) {
        continue;
      }
      const segments = cleaned.split(/\s+as\s+/);
      const exported = (segments[1] ?? segments[0] ?? '').trim();
      add(exported);
    }
  }
  return names;
}

function toPascalCase(stem: string): string {
  return stem
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function relativeImportSpecifier(fromDirectory: string, targetFile: string, framework: FrameworkComponentKind): string {
  const rel = toPosix(path.relative(fromDirectory, targetFile));
  const prefixed = rel.startsWith('.') ? rel : `./${rel}`;
  return framework === 'react' ? prefixed.replace(/\.(?:tsx|jsx)$/i, '') : prefixed;
}

function readPackageExports(packageRoot: string): Readonly<Record<string, unknown>> | undefined {
  const text = readSmallFile(path.join(packageRoot, 'package.json'), FRAMEWORK_COMPONENT_LIMITS.manifestBytesMax);
  if (text === undefined) {
    return undefined;
  }
  try {
    const manifest = toRecord(JSON.parse(text));
    return toRecord(manifest?.['exports']);
  } catch {
    return undefined;
  }
}

function reversePackageExport(packageName: string, relInPkg: string, exportsMap: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (exportsMap === undefined) {
    return undefined;
  }
  for (const [key, rawTarget] of Object.entries(exportsMap)) {
    const target = extractExportString(rawTarget);
    if (target === undefined) {
      continue;
    }
    if (target === relInPkg) {
      return key === '.' ? packageName : `${packageName}/${key.replace(/^\.\//, '')}`;
    }
    const targetStar = target.indexOf('*');
    const keyStar = key.indexOf('*');
    if (targetStar === -1 || keyStar === -1) {
      continue;
    }
    const targetPrefix = target.slice(0, targetStar);
    const targetSuffix = target.slice(targetStar + 1);
    if (!relInPkg.startsWith(targetPrefix) || !relInPkg.endsWith(targetSuffix)) {
      continue;
    }
    const matched = relInPkg.slice(targetPrefix.length, relInPkg.length - targetSuffix.length);
    if (matched.length === 0 || matched.includes('..')) {
      continue;
    }
    const exportedSubpath = key.replace('*', matched).replace(/^\.\//, '');
    return `${packageName}/${exportedSubpath}`;
  }
  return undefined;
}

function extractExportString(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    return raw;
  }
  const targetRecord = toRecord(raw);
  if (targetRecord === undefined) {
    return undefined;
  }
  for (const field of ['import', 'default'] as const) {
    const candidate = targetRecord[field];
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  return undefined;
}

function readSmallFile(file: string, bytesMax: number = FRAMEWORK_COMPONENT_LIMITS.sourceBytesMax): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > bytesMax) {
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

function realRegularFile(file: string): string | undefined {
  try {
    const resolved = fs.realpathSync(file);
    return fs.statSync(resolved).isFile() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function isContainedRealDirectory(realRoot: string, directory: string): boolean {
  const resolvedDirectory = realDirectory(directory);
  return resolvedDirectory !== undefined && (resolvedDirectory === realRoot || isPathDescendant(realRoot, resolvedDirectory));
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}
