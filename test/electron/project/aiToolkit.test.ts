// Goal: verify project-aware AI toolkit inspection (shadcn, HeroUI, Hugeicons,
// connected MCP servers, installed agent skills, and `@shadcn/lint` status) across
// standalone apps and pnpm monorepos, plus contract parsing and generated `SKILL.md`
// frontmatter validity.
// Methodology: create isolated temporary directories simulating standalone and
// monorepo projects, invoke `inspectProjectAiToolkit`, and check positive and
// negative boundary cases on `parseProjectAiToolkit` and `recommendedSkillSource`.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { inspectProjectAiToolkit } from '#dist/electron/project/aiToolkit.js';
import { listInstructions } from '#dist/electron/project/instructionFiles.js';
import { AI_TOOLKIT_IDS, parseProjectAiToolkit, recommendedSkillSource } from '#dist/shared/properties/mcp.js';

function withTemporaryProject(run: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-ai-toolkit-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('detects shadcn and Hugeicons in a standalone Astro project without MCP or skills', () => {
  withTemporaryProject((root) => {
    writeJson(path.join(root, 'package.json'), {
      name: 'my-site',
      dependencies: {
        astro: '^5.0.0',
        '@hugeicons/react': '^1.0.0',
        '@hugeicons/core-free-icons': '^1.0.0',
      },
    });
    writeJson(path.join(root, 'components.json'), {
      style: 'new-york',
      tailwind: { css: 'src/styles/global.css' },
      aliases: { components: '@/components', utils: '@/lib/utils' },
    });

    const toolkit = inspectProjectAiToolkit(root);
    assert.deepEqual(
      toolkit.recommendations.map((item) => item.id),
      ['shadcn', 'hugeicons'],
    );
    const shadcn = toolkit.recommendations[0];
    const hugeicons = toolkit.recommendations[1];
    assert.ok(shadcn !== undefined && hugeicons !== undefined);
    assert.equal(shadcn.mcpProviderId, undefined);
    assert.equal(shadcn.skillInstalled, false);
    assert.equal(hugeicons.mcpProviderId, 'hugeicons');
    assert.equal(hugeicons.mcpConnected, false);
    assert.equal(hugeicons.skillInstalled, false);

    assert.equal(toolkit.shadcnLint.applicable, true);
    assert.equal(toolkit.shadcnLint.installed, false);
    assert.equal(toolkit.shadcnLint.linter, 'none');
    assert.equal(toolkit.shadcnLint.packageManager, 'npm');
  });
});

test('detects shared monorepo shadcn, HeroUI, workspace skills, connected MCP, and installed @shadcn/lint', () => {
  withTemporaryProject((root) => {
    writeText(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
    writeJson(path.join(root, 'package.json'), { name: 'mono-root', private: true });
    writeText(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\n');
    writeJson(path.join(root, '.oxlintrc.json'), { jsPlugins: ['@shadcn/lint'] });
    writeText(path.join(root, '.agents/skills/shadcn/SKILL.md'), recommendedSkillSource('shadcn'));

    const uiPackage = path.join(root, 'packages/ui');
    writeJson(path.join(uiPackage, 'package.json'), { name: '@mono/ui', version: '0.0.0' });
    writeJson(path.join(uiPackage, 'components.json'), {
      style: 'new-york',
      tailwind: { css: 'src/styles/globals.css' },
      aliases: { components: '@mono/ui/components', utils: '@mono/ui/lib/utils' },
    });

    const app = path.join(root, 'apps/site');
    writeJson(path.join(app, 'package.json'), {
      name: '@mono/site',
      dependencies: {
        astro: '^5.0.0',
        '@mono/ui': 'workspace:*',
        '@heroui/react': '^3.0.0',
      },
    });
    writeJson(path.join(app, '.mcp.json'), {
      mcpServers: {
        heroui: { command: 'npx', args: ['-y', '@heroui/react-mcp@latest'] },
      },
    });

    const toolkit = inspectProjectAiToolkit(app);
    assert.deepEqual(
      toolkit.recommendations.map((item) => item.id),
      ['shadcn', 'heroui'],
    );
    const shadcn = toolkit.recommendations.find((item) => item.id === 'shadcn');
    const heroui = toolkit.recommendations.find((item) => item.id === 'heroui');
    assert.ok(shadcn !== undefined && heroui !== undefined);
    assert.equal(shadcn.skillInstalled, true);
    assert.equal(shadcn.packagePath, 'packages/ui');
    assert.equal(heroui.mcpProviderId, 'heroui');
    assert.equal(heroui.mcpConnected, true);
    assert.equal(heroui.skillInstalled, false);

    assert.equal(toolkit.shadcnLint.applicable, true);
    assert.equal(toolkit.shadcnLint.installed, true);
    assert.equal(toolkit.shadcnLint.linter, 'oxlint');
    assert.equal(toolkit.shadcnLint.packageManager, 'pnpm');
    assert.equal(toolkit.shadcnLint.workspaceAppPath, 'apps/site');
  });
});

test('detects ESLint config when project uses shadcn without Oxlint', () => {
  withTemporaryProject((root) => {
    writeJson(path.join(root, 'package.json'), {
      name: 'eslint-site',
      dependencies: { astro: '^5.0.0', 'class-variance-authority': '^0.7.0' },
      devDependencies: { eslint: '^9.0.0' },
    });
    writeJson(path.join(root, 'components.json'), {
      style: 'new-york',
      tailwind: { css: 'src/styles/global.css' },
      aliases: { components: '@/components', utils: '@/lib/utils' },
    });
    writeText(path.join(root, 'eslint.config.mjs'), 'export default [];\n');

    const toolkit = inspectProjectAiToolkit(root);
    assert.equal(toolkit.shadcnLint.applicable, true);
    assert.equal(toolkit.shadcnLint.installed, false);
    assert.equal(toolkit.shadcnLint.linter, 'eslint');
  });
});

test('recommendedSkillSource generates valid SKILL.md frontmatter for every ecosystem', () => {
  withTemporaryProject((root) => {
    for (const id of AI_TOOLKIT_IDS) {
      const source = recommendedSkillSource(id, id === 'shadcn' ? { packagePath: 'packages/ui' } : {});
      writeText(path.join(root, '.claude/skills', id, 'SKILL.md'), source);
    }
    const listed = listInstructions(root);
    const skills = listed.files.filter((file) => file.section === 'skills');
    assert.equal(skills.length, AI_TOOLKIT_IDS.length);
    for (const skill of skills) {
      assert.equal(skill.skill?.kind, 'valid', `expected valid skill frontmatter for ${skill.path}`);
    }
  });
});

test('parseProjectAiToolkit round-trips valid data and rejects malformed input', () => {
  const sample = {
    recommendations: [
      {
        id: 'heroui',
        mcpProviderId: 'heroui',
        mcpConnected: false,
        skillSlug: 'heroui-react',
        skillInstalled: false,
      },
    ],
    shadcnLint: {
      applicable: false,
      installed: false,
      linter: 'none',
      packageManager: 'pnpm',
    },
  };
  assert.deepEqual(parseProjectAiToolkit(sample), sample);

  assert.throws(() => parseProjectAiToolkit({ ...sample, recommendations: [{ ...sample.recommendations[0], id: 'unknown' }] }));
  assert.throws(() => parseProjectAiToolkit({ ...sample, shadcnLint: { ...sample.shadcnLint, linter: 'biome' } }));
  assert.throws(() => parseProjectAiToolkit({ ...sample, shadcnLint: { ...sample.shadcnLint, packageManager: 'pip' } }));
  assert.throws(() =>
    parseProjectAiToolkit({
      ...sample,
      recommendations: [sample.recommendations[0], sample.recommendations[0], sample.recommendations[0], sample.recommendations[0]],
    }),
  );
});
