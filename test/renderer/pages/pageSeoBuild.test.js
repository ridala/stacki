// Goal: verify that Desktop SEO edits reach the generated Astro head while preserving page markup.
// Method: classify annotated layout props, send normal property gestures to the main process,
// then build three pages with Astro and read the generated document head.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath, ROOT } = require('../../helpers/sources');

const output = repoPath('node_modules/.stacki-test/page-seo-build.cjs');
buildSync({
  stdin: {
    contents: `export { pageSeoFields } from './src/features/pages/pageSeo';
    export { propsGesture } from './src/editor/editGestures';
    export { sendGesture } from './src/editor/pageEdits';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  logLevel: 'silent',
});

test('a Desktop SEO property edit reaches Astro output, including explicit false and reset', async (context) => {
  const results = repoPath('studio/test-results');
  fs.mkdirSync(results, { recursive: true });
  const folder = fs.mkdtempSync(path.join(results, 'stacki-page-seo-'));
  const sourceFolder = path.join(folder, 'src');
  const layout = `---
interface Props {
  /** @seo title */
  title?: string;
  /** @seo description */
  description?: string;
  /** @seo canonical */
  canonical?: string;
  /** @seo noindex */
  noindex?: boolean;
}
const { title = 'Site default', description, canonical, noindex = true } = Astro.props;
---
<html lang="en">
  <head>
    <title>{title}</title>
    {description && <meta name="description" content={description} />}
    {canonical && <link rel="canonical" href={canonical} />}
    {noindex && <meta name="robots" content="noindex" />}
  </head>
  <body><slot /></body>
</html>
`;
  fs.mkdirSync(path.join(sourceFolder, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'user'));
  fs.writeFileSync(path.join(folder, 'package.json'), '{"dependencies":{"astro":"*"}}');
  fs.writeFileSync(path.join(sourceFolder, 'Layout.astro'), layout);
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(folder, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  const { parsePageDiskRead, parsePageEditResult } = require('#dist/shared/ipc/pageSave.js');
  const { pageSeoFields, propsGesture, sendGesture } = require(output);
  const { parsePropSchema } = require(repoPath('dist/electron/parse/astroPropSchema.js'));
  const schema = parsePropSchema(layout);
  const indexingStates = [
    { route: 'allow', attr: { type: 'expr', value: 'false' }, noindex: false },
    { route: 'exclude', attr: { type: 'expr', value: 'true' }, noindex: true },
    { route: 'inherit', attr: undefined, noindex: true },
  ];
  const template = `---
import Layout from "../Layout.astro";
---
<Layout title="Before" noindex={false}><p>Keep this content.</p></Layout>
`;
  for (const { route, attr } of indexingStates) {
    const file = path.join(sourceFolder, 'pages', route + '.astro');
    fs.writeFileSync(file, route === 'allow' ? template.replace('noindex={false}', 'noindex={true}') : template);
    const origin = parsePageDiskRead(await harness.invoke('page:read', file));
    assert.ok(origin.editable);
    const node = origin.model.nodes.find((candidate) => candidate.kind === 'component' && candidate.name === 'Layout');
    assert.ok(node);
    const fields = pageSeoFields(schema, node);
    const title = fields.find(({ role }) => role === 'title');
    const description = fields.find(({ role }) => role === 'description');
    const canonical = fields.find(({ role }) => role === 'canonical');
    const indexing = fields.find(({ role }) => role === 'noindex');
    assert.ok(title && description && canonical && indexing);
    const patch = {
      [title.name]: { type: 'string', value: 'Updated & verified' },
      [description.name]: { type: 'string', value: 'A description from Desktop' },
      [canonical.name]: { type: 'string', value: 'https://example.test/' + route },
      [indexing.name]: attr,
    };
    const gesture = propsGesture(node.id, patch, { coalesceKey: undefined, urgency: true });
    const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
    const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
    assert.equal((await sendGesture({ path: file, origin, gesture, record, send })).tag, 'applied');
    const written = fs.readFileSync(file, 'utf8');
    assert.match(written, /<p>Keep this content\.<\/p>/);
    if (attr === undefined) {
      assert.doesNotMatch(written, /noindex=/);
    }
  }

  execFileSync(process.execPath, [repoPath('studio/node_modules/astro/bin/astro.mjs'), 'build'], {
    cwd: folder,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', CI: 'true' },
    timeout: 60_000,
    killSignal: 'SIGKILL',
    stdio: 'inherit',
  });
  for (const { route, noindex } of indexingStates) {
    const built = new JSDOM(fs.readFileSync(path.join(folder, 'dist', route, 'index.html'), 'utf8'));
    assert.equal(built.window.document.title, 'Updated & verified');
    assert.equal(built.window.document.querySelector('meta[name="description"]')?.content, 'A description from Desktop');
    assert.equal(built.window.document.querySelector('link[rel="canonical"]')?.href, 'https://example.test/' + route);
    assert.equal(built.window.document.querySelector('meta[name="robots"]')?.content, noindex ? 'noindex' : undefined);
    built.window.close();
  }
});
