// Read-only detection of UI ecosystems (shadcn, HeroUI, Hugeicons), their connected MCP servers,
// installed agent skills, and optional `@shadcn/lint` setup across an Astro app and its monorepo.
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { toRecord } from '../../shared/core/record';
import type { AiToolkitId, AiToolkitRecommendation, ProjectAiToolkit, ShadcnLintLinter } from '../../shared/properties/mcp';
import { isPathDescendant } from '../lib/platform';
import { listInstructions } from './instructionFiles';
import { detectPackageManager } from './packageManager';
import { readShadcnSettings } from './shadcnSettings';
import { findEnclosingWorkspace, findWorkspacePackages, readProjectDependencyNames } from './workspaceAstro';

const CONFIG_BYTES_MAX = 256 * 1024;
const SKILL_ROOT_FOLDERS = ['.claude/skills', '.agents/skills', '.cursor/skills'] as const;
const ESLINT_CONFIG_NAMES = ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.ts', 'eslint.config.cjs'] as const;

const HEROUI_PACKAGES = new Set(['@heroui/react', '@heroui/styles', '@heroui/theme', '@heroui/system']);
const HUGEICONS_EXACT_PACKAGES = new Set(['hugeicons-react']);

const SKILL_MATCH_SLUGS: Readonly<Record<AiToolkitId, readonly string[]>> = {
  shadcn: ['shadcn', 'shadcn-ui'],
  heroui: ['heroui-react', 'heroui'],
  hugeicons: ['hugeicons'],
};

const DEFAULT_SKILL_SLUGS: Readonly<Record<AiToolkitId, string>> = {
  shadcn: 'shadcn',
  heroui: 'heroui-react',
  hugeicons: 'hugeicons',
};

/**
 * Inspects `projectPath` (and its enclosing monorepo workspace, if any) to report which AI toolkit
 * integrations (MCP servers, Agent Skills, and `@shadcn/lint`) apply and which are already installed.
 */
export function inspectProjectAiToolkit(projectPath: string): ProjectAiToolkit {
  assert(path.isAbsolute(projectPath), 'inspectProjectAiToolkit: projectPath must be absolute');
  const normalizedProject = path.resolve(projectPath);
  const workspace = findEnclosingWorkspace(normalizedProject);
  const allDependencies = collectEcosystemDependencies(normalizedProject, workspace?.workspaceRoot);

  const shadcnReply = readShadcnSettings(normalizedProject);
  const shadcnSettings = shadcnReply.ok ? shadcnReply.value : undefined;
  const hasShadcn = shadcnSettings !== undefined || allDependencies.has('shadcn');
  const hasHeroui = [...allDependencies].some((name) => HEROUI_PACKAGES.has(name));
  const hasHugeicons = [...allDependencies].some((name) => HUGEICONS_EXACT_PACKAGES.has(name) || name.startsWith('@hugeicons/'));

  const mcpConnected = readConnectedToolkitMcp(uniqueDirectories([normalizedProject, workspace?.workspaceRoot]));
  const installedSkills = collectInstalledSkills(normalizedProject, workspace?.workspaceRoot);

  const recommendations: AiToolkitRecommendation[] = [];
  if (hasShadcn) {
    const skillPath = findInstalledSkill(installedSkills, 'shadcn');
    recommendations.push({
      id: 'shadcn',
      mcpConnected: false,
      skillSlug: DEFAULT_SKILL_SLUGS.shadcn,
      skillInstalled: skillPath !== undefined,
      ...(skillPath === undefined ? {} : { skillPath }),
      ...(shadcnSettings?.packagePath === undefined ? {} : { packagePath: shadcnSettings.packagePath }),
    });
  }
  if (hasHeroui) {
    const skillPath = findInstalledSkill(installedSkills, 'heroui');
    recommendations.push({
      id: 'heroui',
      mcpProviderId: 'heroui',
      mcpConnected: mcpConnected.heroui,
      skillSlug: DEFAULT_SKILL_SLUGS.heroui,
      skillInstalled: skillPath !== undefined,
      ...(skillPath === undefined ? {} : { skillPath }),
    });
  }
  if (hasHugeicons) {
    const skillPath = findInstalledSkill(installedSkills, 'hugeicons');
    recommendations.push({
      id: 'hugeicons',
      mcpProviderId: 'hugeicons',
      mcpConnected: mcpConnected.hugeicons,
      skillSlug: DEFAULT_SKILL_SLUGS.hugeicons,
      skillInstalled: skillPath !== undefined,
      ...(skillPath === undefined ? {} : { skillPath }),
    });
  }

  const shadcnPackageDirectory =
    shadcnSettings?.packagePath !== undefined && workspace !== undefined
      ? path.resolve(workspace.workspaceRoot, ...shadcnSettings.packagePath.split('/'))
      : undefined;
  const lintDirectories = uniqueDirectories([normalizedProject, shadcnPackageDirectory, workspace?.workspaceRoot]);
  const lintState = detectShadcnLintState(lintDirectories, allDependencies);

  return {
    recommendations,
    shadcnLint: {
      applicable: hasShadcn,
      installed: lintState.installed,
      linter: lintState.linter,
      packageManager: detectPackageManager(normalizedProject) ?? 'npm',
      ...(workspace === undefined ? {} : { workspaceAppPath: workspace.relativeAppPath }),
    },
  };
}

function collectEcosystemDependencies(projectPath: string, workspaceRoot: string | undefined): ReadonlySet<string> {
  const names = new Set<string>(readProjectDependencyNames(projectPath));
  if (workspaceRoot === undefined) {
    return names;
  }
  for (const dependency of readProjectDependencyNames(workspaceRoot)) {
    names.add(dependency);
  }
  const declaredProjectDeps = readProjectDependencyNames(projectPath);
  for (const workspacePackage of findWorkspacePackages(workspaceRoot)) {
    if (!declaredProjectDeps.has(workspacePackage.name)) {
      continue;
    }
    for (const dependency of readProjectDependencyNames(workspacePackage.packagePath)) {
      names.add(dependency);
    }
  }
  return names;
}

function readConnectedToolkitMcp(directories: readonly string[]): { readonly heroui: boolean; readonly hugeicons: boolean } {
  let heroui = false;
  let hugeicons = false;
  for (const directory of directories) {
    const raw = readSmallFile(path.join(directory, '.mcp.json'));
    if (raw === undefined) {
      continue;
    }
    try {
      const parsed = toRecord(JSON.parse(raw));
      const servers = toRecord(parsed?.['mcpServers']);
      if (servers === undefined) {
        continue;
      }
      for (const [serverName, entry] of Object.entries(servers)) {
        const lowerName = serverName.toLowerCase();
        if (lowerName === 'heroui' || lowerName === 'heroui-react') {
          heroui = true;
        }
        if (lowerName === 'hugeicons') {
          hugeicons = true;
        }
        const serverRecord = toRecord(entry);
        if (serverRecord === undefined) {
          continue;
        }
        if (typeof serverRecord['url'] === 'string') {
          const lowerUrl = serverRecord['url'].toLowerCase();
          if (lowerUrl.includes('hugeicons.com')) {
            hugeicons = true;
          }
          if (lowerUrl.includes('heroui')) {
            heroui = true;
          }
        }
        const parts: string[] = [];
        if (typeof serverRecord['command'] === 'string') {
          parts.push(serverRecord['command']);
        }
        if (Array.isArray(serverRecord['args'])) {
          for (const item of serverRecord['args']) {
            if (typeof item === 'string') {
              parts.push(item);
            }
          }
        }
        const joined = parts.join(' ').toLowerCase();
        if (joined.includes('@heroui/react-mcp') || joined.includes('heroui-mcp')) {
          heroui = true;
        }
        if (joined.includes('@hugeicons/mcp-server') || joined.includes('hugeicons')) {
          hugeicons = true;
        }
      }
    } catch {
      // Ignore malformed .mcp.json during optional recommendation checks.
    }
  }
  return { heroui, hugeicons };
}

function collectInstalledSkills(projectPath: string, workspaceRoot: string | undefined): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  const listing = listInstructions(projectPath);
  for (const entry of listing.files) {
    if (entry.section !== 'skills') {
      continue;
    }
    const slug = skillSlugFromPath(entry.path);
    if (slug !== undefined && !found.has(slug)) {
      found.set(slug, entry.path);
    }
    if (entry.skill?.kind === 'valid') {
      const metaName = entry.skill.name.trim().toLowerCase();
      if (metaName.length > 0 && !found.has(metaName)) {
        found.set(metaName, entry.path);
      }
    }
  }
  // Also recognize skills installed at the enclosing monorepo root (`.claude/skills`, `.agents/skills`, `.cursor/skills`).
  if (workspaceRoot !== undefined && path.resolve(workspaceRoot) !== path.resolve(projectPath)) {
    const realWorkspace = realDirectory(workspaceRoot);
    if (realWorkspace !== undefined) {
      for (const rootFolder of SKILL_ROOT_FOLDERS) {
        const container = path.join(realWorkspace, ...rootFolder.split('/'));
        if (!isContainedRealDirectory(realWorkspace, container)) {
          continue;
        }
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(container, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of entries) {
          if (!child.isDirectory() || child.isSymbolicLink() || child.name.startsWith('.')) {
            continue;
          }
          const skillFile = path.join(container, child.name, 'SKILL.md');
          try {
            if (!fs.statSync(skillFile).isFile()) {
              continue;
            }
          } catch {
            continue;
          }
          const slug = child.name.toLowerCase();
          if (!found.has(slug)) {
            found.set(slug, `${rootFolder}/${child.name}/SKILL.md`);
          }
        }
      }
    }
  }
  return found;
}

function findInstalledSkill(installed: ReadonlyMap<string, string>, id: AiToolkitId): string | undefined {
  for (const slug of SKILL_MATCH_SLUGS[id]) {
    const match = installed.get(slug);
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

function skillSlugFromPath(relativePath: string): string | undefined {
  const parts = relativePath.split('/');
  if (parts.length < 2) {
    return undefined;
  }
  const folder = parts[parts.length - 2];
  return folder === undefined || folder.length === 0 ? undefined : folder.toLowerCase();
}

function detectShadcnLintState(
  directories: readonly string[],
  dependencies: ReadonlySet<string>,
): { readonly installed: boolean; readonly linter: ShadcnLintLinter } {
  let installed = dependencies.has('@shadcn/lint');
  let hasOxlint = dependencies.has('oxlint');
  let hasEslint = dependencies.has('eslint');

  for (const directory of directories) {
    const oxlintConfig = readSmallFile(path.join(directory, '.oxlintrc.json'));
    if (oxlintConfig !== undefined) {
      hasOxlint = true;
      if (oxlintConfig.includes('@shadcn/lint')) {
        installed = true;
      }
    }
    const oxlintTs = readSmallFile(path.join(directory, 'oxlint.config.ts'));
    if (oxlintTs !== undefined) {
      hasOxlint = true;
      if (oxlintTs.includes('@shadcn/lint')) {
        installed = true;
      }
    }
    for (const eslintName of ESLINT_CONFIG_NAMES) {
      const eslintConfig = readSmallFile(path.join(directory, eslintName));
      if (eslintConfig !== undefined) {
        hasEslint = true;
        if (eslintConfig.includes('@shadcn/lint')) {
          installed = true;
        }
      }
    }
    const packageJson = readSmallFile(path.join(directory, 'package.json'));
    if (packageJson !== undefined) {
      try {
        const parsed = toRecord(JSON.parse(packageJson));
        const scripts = toRecord(parsed?.['scripts']);
        if (scripts !== undefined) {
          for (const script of Object.values(scripts)) {
            if (typeof script === 'string' && script.includes('oxlint')) {
              hasOxlint = true;
            }
          }
        }
      } catch {
        // Ignore malformed package.json scripts during optional linter detection.
      }
    }
  }

  const linter: ShadcnLintLinter = hasOxlint ? 'oxlint' : hasEslint ? 'eslint' : 'none';
  return { installed, linter };
}

function uniqueDirectories(candidates: ReadonlyArray<string | undefined>): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    if (candidate === undefined) {
      continue;
    }
    const resolved = path.resolve(candidate);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

function readSmallFile(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > CONFIG_BYTES_MAX) {
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

function isContainedRealDirectory(realRoot: string, directory: string): boolean {
  const resolved = realDirectory(directory);
  return resolved !== undefined && (resolved === realRoot || isPathDescendant(realRoot, resolved));
}
