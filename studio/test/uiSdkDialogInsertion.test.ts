// Exercise source discovery and insertion for a React island behind an Astro wrapper.
// The fixture is scanned and its recipe is applied to real Astro source without installing the SDK.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadInsertionDefaults } from '../src/features/settings/loadDefaults';
import { applyEdits, flatten, nodesOf } from '../src/features/source/source';
import { structuralEdits } from '../src/features/source/sourceOperations';
import { defaultsIssues } from '../vendor/stacki/shared/properties/componentDefaults';

test('the Dialog wrapper exposes editable content and inserts a named body slot', async () => {
  const root = path.join(import.meta.dirname, 'fixtures/ui-sdk-dialog');
  const pageFile = 'src/pages/index.astro';
  const wrapperFile = 'src/components/ProjectDialog.astro';
  const [defaults, source] = await Promise.all([loadInsertionDefaults(root), readFile(path.join(root, pageFile), 'utf8')]);
  const wrapper = defaults.imports.find((component) => component.file === wrapperFile);
  assert.ok(wrapper);
  assert.deepEqual(defaults.imports.map((component) => component.file), [wrapperFile]);
  assert.equal(wrapper.fields.find((field) => field.name === 'label')?.type, 'string');
  assert.deepEqual(wrapper.slots, ['body']);
  assert.deepEqual(defaultsIssues(defaults.config, defaults.catalog), []);

  const main = flatten(nodesOf(source)).find((node) => node.name === 'main');
  assert.ok(main?.id);
  const output = applyEdits(
    source,
    structuralEdits(
      source,
      { kind: 'insert', target: main.id, name: wrapper.name, importPath: '../components/ProjectDialog.astro', paired: true },
      pageFile,
      defaults,
    ),
  );
  assert.match(output, /import ProjectDialog from "\.\.\/components\/ProjectDialog\.astro";/);
  assert.match(output, /<ProjectDialog label="Project details">\s*<p slot="body">Review the project details\.<\/p>\s*<\/ProjectDialog>/);
  assert.match(output, /<title>Project overview<\/title>/);
  assert.match(output, /<link rel="canonical" href=\{canonical\} \/>/);
  assert.match(output, /<p>The project is open for review\.<\/p>/);
});
