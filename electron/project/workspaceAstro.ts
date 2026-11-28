// Discovering Astro applications inside a monorepo workspace without mutating files or following symlinks.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assert } from '../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';
import { toRecord } from '../../shared/core/record';
import { WORKSPACE_ASTRO_APPS_MAX, type WorkspaceAstroApp } from '../../shared/ipc/astroCopy';
import { ancestorsOf } from './packageManager';
import { isAstroProject } from './projectFiles';

export const WORKSPACE_ASTRO_LIMITS = {
  /** Workspace glob patterns read from pnpm-workspace.yaml and package.json. */
  patternsMax: 64,
  /** Candidate directories checked for Astro projects inside a picked root. */
  candidatesMax: 256,
  /** Maximum size in bytes of a workspace config file read during discovery. */
  configBytesMax: 64 * 1024,
  /** Maximum depth below a workspace root when expanding glob patterns. */
  depthMax: 2,
  /** Maximum entries read inside a candidate src/pages folder. */
  pagesEntriesMax: 256,
} as const satisfies Record<string, number>;

const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.astro', '.stacki', 'coverage', '.turbo', '.next', '.nuxt']);
const MONOREPO_MARKER_FILES = ['pnpm-workspace.yaml', 'lerna.json', 'turbo.json', 'nx.json'] as const;

export interface EnclosingWorkspace {
  readonly workspaceRoot: string;
  readonly workspaceName: string;
  readonly relativeAppPath: string;
}

export interface WorkspacePackage {
  readonly name: string;
  readonly relativePath: string;
  readonly packagePath: string;
}

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** Lists declared workspace packages (with a package.json name) inside `workspaceRoot` without following symlinks. */
export function findWorkspacePackages(workspaceRoot: string): readonly WorkspacePackage[] {
  assert(path.isAbsolute(workspaceRoot), 'findWorkspacePackages: workspaceRoot must be absolute');
  const normalized = path.resolve(workspaceRoot);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(normalized);
  } catch {
    return [];
  }
  const declared = readWorkspacePatterns(normalized);
  const candidates = declared.length > 0 ? expandWorkspacePatterns(normalized, realRoot, declared) : walkWorkspaceCandidates(normalized, realRoot);
  const packages: WorkspacePackage[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.projectPath)) {
      continue;
    }
    seen.add(candidate.projectPath);
    const name = readPackageName(candidate.projectPath);
    if (name !== undefined) {
      packages.push({ name, relativePath: candidate.relativePath, packagePath: candidate.projectPath });
    }
  }
  packages.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath === right.relativePath ? 1 : 0));
  assert(packages.length <= WORKSPACE_ASTRO_LIMITS.candidatesMax, 'findWorkspacePackages: result stays bounded');
  return packages;
}

/** Reads the set of package names listed in `directory/package.json` dependency fields. */
export function readProjectDependencyNames(directory: string): ReadonlySet<string> {
  assert(path.isAbsolute(directory), 'readProjectDependencyNames: directory must be absolute');
  const text = readSmallFile(path.join(directory, 'package.json'));
  if (text === undefined) {
    return new Set();
  }
  const names = new Set<string>();
  try {
    const manifest = toRecord(JSON.parse(text));
    if (manifest === undefined) {
      return names;
    }
    for (const section of DEPENDENCY_SECTIONS) {
      const entries = toRecord(manifest[section]);
      if (entries === undefined) {
        continue;
      }
      for (const dependencyName of Object.keys(entries)) {
        if (names.size >= WORKSPACE_ASTRO_LIMITS.candidatesMax) {
          return names;
        }
        names.add(dependencyName);
      }
    }
  } catch {
    return new Set();
  }
  return names;
}

function walkWorkspaceCandidates(root: string, realRoot: string): readonly CandidateDirectory[] {
  const found: CandidateDirectory[] = [];
  const queue: Array<{ readonly absolute: string; readonly relativePath: string; readonly depth: number }> = [{ absolute: root, relativePath: '', depth: 0 }];
  let inspected = 0;
  while (queue.length > 0 && inspected < WORKSPACE_ASTRO_LIMITS.candidatesMax) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    for (const child of listChildDirectories(current.absolute)) {
      if (inspected >= WORKSPACE_ASTRO_LIMITS.candidatesMax) {
        break;
      }
      inspected += 1;
      const nextRelative = current.relativePath.length === 0 ? child : `${current.relativePath}/${child}`;
      const nextAbsolute = path.join(current.absolute, child);
      if (!isContainedRealDirectory(realRoot, nextAbsolute)) {
        continue;
      }
      found.push({ relativePath: nextRelative, projectPath: nextAbsolute });
      if (current.depth + 1 < WORKSPACE_ASTRO_LIMITS.depthMax) {
        queue.push({ absolute: nextAbsolute, relativePath: nextRelative, depth: current.depth + 1 });
      }
    }
  }
  return found;
}

/**
 * Finds Astro applications nested inside `directory` when `directory` is a monorepo or workspace root.
 * Reads declared workspace patterns (`pnpm-workspace.yaml`, `package.json#workspaces`, `lerna.json`) first
 * and falls back to a bounded 2-level directory walk so any monorepo layout is discovered.
 * Never follows symlinks or writes to disk.
 */
export function findWorkspaceAstroApps(directory: string): readonly WorkspaceAstroApp[] {
  assert(path.isAbsolute(directory), 'findWorkspaceAstroApps: directory must be absolute');
  assert(path.resolve(directory) === directory, 'findWorkspaceAstroApps: directory must be normalized');
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(directory);
  } catch {
    return [];
  }
  const declared = readWorkspacePatterns(directory);
  if (declared.length > 0) {
    const fromPatterns = collectAstroApps(expandWorkspacePatterns(directory, realRoot, declared));
    if (fromPatterns.length > 0) {
      return fromPatterns;
    }
  }
  return scanWorkspaceAstroApps(directory, realRoot);
}

/** Finds the nearest enclosing workspace root above `projectPath`, if any. */
export function findEnclosingWorkspace(projectPath: string): EnclosingWorkspace | undefined {
  assert(path.isAbsolute(projectPath), 'findEnclosingWorkspace: projectPath must be absolute');
  const resolvedProject = path.resolve(projectPath);
  for (const ancestor of ancestorsOf(resolvedProject).slice(1)) {
    if (!isWorkspaceRoot(ancestor)) {
      continue;
    }
    const relative = path.relative(ancestor, resolvedProject);
    if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
      continue;
    }
    const posixRelative = relative.split(path.sep).join('/');
    if (posixRelative.length > BOUNDARY_LIMITS.pathLengthMax) {
      continue;
    }
    return {
      workspaceRoot: ancestor,
      workspaceName: readPackageName(ancestor) ?? path.basename(ancestor),
      relativeAppPath: posixRelative,
    };
  }
  return undefined;
}

function isWorkspaceRoot(directory: string): boolean {
  if (readWorkspacePatterns(directory).length > 0) {
    return true;
  }
  return MONOREPO_MARKER_FILES.some((marker) => readSmallFile(path.join(directory, marker)) !== undefined);
}

function collectAstroApps(candidates: readonly CandidateDirectory[]): readonly WorkspaceAstroApp[] {
  const discovered: WorkspaceAstroApp[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (discovered.length >= WORKSPACE_ASTRO_APPS_MAX) {
      break;
    }
    if (seen.has(candidate.projectPath)) {
      continue;
    }
    seen.add(candidate.projectPath);
    if (!isAstroProject(candidate.projectPath) && !hasAstroPagesFolder(candidate.projectPath)) {
      continue;
    }
    discovered.push({
      name: readPackageName(candidate.projectPath) ?? path.basename(candidate.projectPath),
      relativePath: candidate.relativePath,
      projectPath: candidate.projectPath,
    });
  }
  discovered.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath === right.relativePath ? 1 : 0));
  assert(discovered.length <= WORKSPACE_ASTRO_APPS_MAX, 'collectAstroApps: result stays bounded');
  return discovered;
}

// Bounded breadth-first walk up to depth 2 for monorepos with custom folder layouts or no workspace manifest.
function scanWorkspaceAstroApps(root: string, realRoot: string): readonly WorkspaceAstroApp[] {
  const discovered: WorkspaceAstroApp[] = [];
  const queue: Array<{ readonly absolute: string; readonly relativePath: string; readonly depth: number }> = [{ absolute: root, relativePath: '', depth: 0 }];
  let inspected = 0;
  while (queue.length > 0 && inspected < WORKSPACE_ASTRO_LIMITS.candidatesMax && discovered.length < WORKSPACE_ASTRO_APPS_MAX) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const children = listChildDirectories(current.absolute);
    for (const child of children) {
      if (inspected >= WORKSPACE_ASTRO_LIMITS.candidatesMax || discovered.length >= WORKSPACE_ASTRO_APPS_MAX) {
        break;
      }
      inspected += 1;
      const nextRelative = current.relativePath.length === 0 ? child : `${current.relativePath}/${child}`;
      const nextAbsolute = path.join(current.absolute, child);
      if (!isContainedRealDirectory(realRoot, nextAbsolute)) {
        continue;
      }
      if (isAstroProject(nextAbsolute) || hasAstroPagesFolder(nextAbsolute)) {
        discovered.push({
          name: readPackageName(nextAbsolute) ?? child,
          relativePath: nextRelative,
          projectPath: nextAbsolute,
        });
        // Do not descend into an Astro app's own folders (like src/ or public/).
        continue;
      }
      if (current.depth + 1 < WORKSPACE_ASTRO_LIMITS.depthMax) {
        queue.push({ absolute: nextAbsolute, relativePath: nextRelative, depth: current.depth + 1 });
      }
    }
  }
  discovered.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath === right.relativePath ? 1 : 0));
  assert(discovered.length <= WORKSPACE_ASTRO_APPS_MAX, 'scanWorkspaceAstroApps: result stays bounded');
  return discovered;
}

function readWorkspacePatterns(directory: string): readonly string[] {
  const collected: string[] = [];
  const addPattern = (entry: unknown): void => {
    if (collected.length >= WORKSPACE_ASTRO_LIMITS.patternsMax) {
      return;
    }
    if (typeof entry !== 'string') {
      return;
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.startsWith('!')) {
      return;
    }
    const cleaned = trimmed.replace(/^\.\//, '').replace(/\/+$/, '');
    if (cleaned.length > 0 && !cleaned.includes('..') && !path.isAbsolute(cleaned)) {
      collected.push(cleaned);
    }
  };

  const pnpmFile = readSmallFile(path.join(directory, 'pnpm-workspace.yaml'));
  if (pnpmFile !== undefined) {
    try {
      const parsed: unknown = parseYaml(pnpmFile);
      const packages = toRecord(parsed)?.['packages'];
      if (Array.isArray(packages)) {
        for (const item of packages) {
          addPattern(item);
        }
      }
    } catch {
      // Malformed YAML is ignored; package.json workspaces can still be checked.
    }
  }

  const manifestFile = readSmallFile(path.join(directory, 'package.json'));
  if (manifestFile !== undefined) {
    try {
      const parsed: unknown = JSON.parse(manifestFile);
      const workspaces = toRecord(parsed)?.['workspaces'];
      if (Array.isArray(workspaces)) {
        for (const item of workspaces) {
          addPattern(item);
        }
      } else {
        const packages = toRecord(workspaces)?.['packages'];
        if (Array.isArray(packages)) {
          for (const item of packages) {
            addPattern(item);
          }
        }
      }
    } catch {
      // Malformed package.json is ignored during read-only discovery.
    }
  }

  const lernaFile = readSmallFile(path.join(directory, 'lerna.json'));
  if (lernaFile !== undefined) {
    try {
      const parsed: unknown = JSON.parse(lernaFile);
      const packages = toRecord(parsed)?.['packages'];
      if (Array.isArray(packages)) {
        for (const item of packages) {
          addPattern(item);
        }
      }
    } catch {
      // Malformed lerna.json is ignored during read-only discovery.
    }
  }

  assert(collected.length <= WORKSPACE_ASTRO_LIMITS.patternsMax, 'readWorkspacePatterns: bounded by patternsMax');
  return collected;
}

interface CandidateDirectory {
  readonly relativePath: string;
  readonly projectPath: string;
}

function expandWorkspacePatterns(root: string, realRoot: string, patterns: readonly string[]): readonly CandidateDirectory[] {
  const candidates: CandidateDirectory[] = [];
  const visited = new Set<string>();

  const considerDirectory = (relativePath: string): void => {
    if (candidates.length >= WORKSPACE_ASTRO_LIMITS.candidatesMax) {
      return;
    }
    const normalizedRelative = relativePath.replace(/\/+$/, '');
    if (normalizedRelative.length === 0 || visited.has(normalizedRelative)) {
      return;
    }
    visited.add(normalizedRelative);
    const segments = normalizedRelative.split('/');
    if (segments.length > WORKSPACE_ASTRO_LIMITS.depthMax + 1) {
      return;
    }
    if (
      segments.some(
        (segment) => segment.length === 0 || segment === '.' || segment === '..' || segment.startsWith('.') || SKIPPED_DIRECTORIES.has(segment.toLowerCase()),
      )
    ) {
      return;
    }
    const absolute = path.join(root, ...segments);
    if (!isContainedRealDirectory(realRoot, absolute)) {
      return;
    }
    candidates.push({ relativePath: normalizedRelative, projectPath: absolute });
  };

  for (const pattern of patterns) {
    if (candidates.length >= WORKSPACE_ASTRO_LIMITS.candidatesMax) {
      break;
    }
    const segments = pattern.split('/').filter((segment) => segment.length > 0);
    if (segments.length === 0 || segments.length > WORKSPACE_ASTRO_LIMITS.depthMax + 1) {
      continue;
    }
    if (!segments.some((segment) => segment.includes('*'))) {
      considerDirectory(segments.join('/'));
      continue;
    }
    expandSegments(root, realRoot, segments, considerDirectory, () => candidates.length < WORKSPACE_ASTRO_LIMITS.candidatesMax);
  }

  assert(candidates.length <= WORKSPACE_ASTRO_LIMITS.candidatesMax, 'expandWorkspacePatterns: bounded by candidatesMax');
  return candidates;
}

// Iterative bounded expansion over pattern segments (depth is at most depthMax + 1).
function expandSegments(
  root: string,
  realRoot: string,
  segments: readonly string[],
  collect: (relativePath: string) => void,
  canContinue: () => boolean,
): void {
  assert(segments.length <= WORKSPACE_ASTRO_LIMITS.depthMax + 1, 'expandSegments: segment depth stays bounded');
  const queue: Array<{ readonly prefix: string; readonly index: number }> = [{ prefix: '', index: 0 }];
  let steps = 0;
  const stepsMax = WORKSPACE_ASTRO_LIMITS.candidatesMax * 4;
  while (queue.length > 0 && canContinue() && steps < stepsMax) {
    steps += 1;
    const item = queue.shift();
    if (item === undefined) {
      break;
    }
    const segment = segments[item.index];
    if (segment === undefined) {
      if (item.prefix.length > 0) {
        collect(item.prefix);
      }
      continue;
    }
    const currentDirectory = item.prefix.length === 0 ? root : path.join(root, ...item.prefix.split('/'));
    if (!isContainedRealDirectory(realRoot, currentDirectory)) {
      continue;
    }
    if (segment === '**') {
      const children = listChildDirectories(currentDirectory);
      for (const child of children) {
        if (!canContinue()) {
          return;
        }
        const nextPrefix = item.prefix.length === 0 ? child : `${item.prefix}/${child}`;
        collect(nextPrefix);
        if (nextPrefix.split('/').length <= WORKSPACE_ASTRO_LIMITS.depthMax) {
          const grandchildren = listChildDirectories(path.join(currentDirectory, child));
          for (const grandchild of grandchildren) {
            if (!canContinue()) {
              return;
            }
            collect(`${nextPrefix}/${grandchild}`);
          }
        }
      }
      continue;
    }
    if (!segment.includes('*')) {
      const nextPrefix = item.prefix.length === 0 ? segment : `${item.prefix}/${segment}`;
      queue.push({ prefix: nextPrefix, index: item.index + 1 });
      continue;
    }
    const matcher = segmentGlobToRegExp(segment);
    const children = listChildDirectories(currentDirectory);
    for (const child of children) {
      if (!canContinue()) {
        return;
      }
      if (!matcher.test(child)) {
        continue;
      }
      const nextPrefix = item.prefix.length === 0 ? child : `${item.prefix}/${child}`;
      queue.push({ prefix: nextPrefix, index: item.index + 1 });
    }
  }
}

function listChildDirectories(directory: string): readonly string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (names.length >= WORKSPACE_ASTRO_LIMITS.candidatesMax) {
      break;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) {
      continue;
    }
    names.push(entry.name);
  }
  return names.sort((left, right) => (left < right ? -1 : left === right ? 1 : 0));
}

function isContainedRealDirectory(realRoot: string, candidate: string): boolean {
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return false;
    }
    const realCandidate = fs.realpathSync(candidate);
    const relative = path.relative(realRoot, realCandidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function segmentGlobToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function hasAstroPagesFolder(directory: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(directory, 'src', 'pages'), { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.slice(0, WORKSPACE_ASTRO_LIMITS.pagesEntriesMax).some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.astro'));
}

function readPackageName(directory: string): string | undefined {
  const text = readSmallFile(path.join(directory, 'package.json'));
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const name = toRecord(parsed)?.['name'];
    if (typeof name === 'string') {
      const trimmed = name.trim();
      if (trimmed.length > 0 && trimmed.length <= 128) {
        return trimmed;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readSmallFile(filePath: string): string | undefined {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > WORKSPACE_ASTRO_LIMITS.configBytesMax) {
      return undefined;
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}
