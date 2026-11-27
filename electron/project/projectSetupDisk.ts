// A setup scan reads a bounded snapshot without following links or evaluating source.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../shared/core/boundary';
import { ASTRO_CONFIG_FILES, pagesFolderOf, projectFolderOfLiteral, sourceDirectoryFromConfig } from '../../shared/properties/astroSourceDirectory';
import { PROJECT_SETUP_ENTRIES_MAX, type ProjectSetupReport } from '../../shared/ipc/projectSetup';
import { PROJECT_FOLDERS_FILE, PROJECT_FOLDER_LIMITS, readProjectFoldersSource } from '../../shared/properties/projectFolders';
import { errorCode } from './projectWalk';

const SOURCE_BYTES_MAX = 256 * 1024;
const DIRECTORY_LEVELS_MAX = 32;
const DIRECTORY_BUFFER_SIZE = 32;

export interface SetupPages {
  readonly folder: string;
  readonly source: ProjectSetupReport['pagesSource'];
  readonly witness: readonly string[];
}

export interface SetupFile {
  readonly path: string;
  readonly size: number;
  readonly witness: string;
}

export function setupPages(root: string): SetupPages {
  const files = ASTRO_CONFIG_FILES.filter((file) => checkedEntry(root, file).kind !== 'missing');
  const file = files[0];
  if (file === undefined) {
    return { folder: pagesFolderOf(undefined), source: 'default', witness: [] };
  }
  const reading = setupText(root, file, SOURCE_BYTES_MAX);
  const witness = [...files, reading.kind === 'text' ? hashText(reading.text) : reading.kind];
  // Installed Astro prefers .ts to .mts and does not search .cjs. Desktop discovery
  // does search .cjs. Studio can also select a config explicitly. Ambiguity blocks setup.
  if (files.length === 1 && file !== 'astro.config.cjs' && reading.kind === 'text') {
    const directory = sourceDirectory(file, reading.text);
    if (directory.kind === 'verified') {
      return { folder: pagesFolderOf(directory.value), source: directory.value === undefined ? 'default' : 'literal', witness };
    }
  }
  return { folder: pagesFolderOf(undefined), source: 'unverified', witness };
}

export function setupMetadata(root: string) {
  const reading = setupText(root, PROJECT_FOLDERS_FILE, PROJECT_FOLDER_LIMITS.fileCharsMax * 4);
  if (reading.kind === 'blocked') {
    return { kind: 'unavailable' } as const;
  }
  const base = reading.kind === 'text' ? reading.text : undefined;
  const result = readProjectFoldersSource(base);
  if (result.kind === 'invalid') {
    return { kind: 'unavailable' } as const;
  }
  return { kind: 'editable', base, config: result.kind === 'ready' ? result.config : undefined } as const;
}

export function setupInventory(root: string, roots: readonly string[], timeAvailable: () => boolean) {
  assert(roots.length <= 3, 'Setup inventories source, public and a separate pages root at most');
  assert(new Set(roots).size === roots.length, 'Setup inventory roots are unique');
  const pending = [...roots];
  const files: SetupFile[] = [];
  let remaining = PROJECT_SETUP_ENTRIES_MAX;
  let incomplete = false;
  inventory: for (let index = 0; index < pending.length && remaining > 0; index += 1) {
    if (!timeAvailable()) {
      incomplete = true;
      break;
    }
    const relative = pending[index];
    assert(relative !== undefined, 'Setup inventory has a directory at its current index');
    const directory = checkedEntry(root, relative);
    switch (directory.kind) {
      case 'missing':
        continue;
      case 'file':
      case 'blocked':
        incomplete = true;
        continue;
      case 'directory':
        break;
      default: {
        const exhaustive: never = directory;
        return exhaustive;
      }
    }
    try {
      if (fs.realpathSync(directory.absolute) !== directory.absolute) {
        incomplete = true;
        continue;
      }
      const listing = fs.opendirSync(directory.absolute, { bufferSize: DIRECTORY_BUFFER_SIZE });
      try {
        for (; remaining > 0; remaining -= 1) {
          if (!timeAvailable()) {
            incomplete = true;
            break inventory;
          }
          const entry = listing.readSync();
          if (!entry) {
            break;
          }
          if (entry.name === 'node_modules' || entry.name === '.stacki') {
            // Desktop ignores these, while Studio's source walk can discover nested packages.
            incomplete ||= entry.name === 'node_modules';
            continue;
          }
          const entryPath = `${relative}/${entry.name}`;
          if (entryPath.length > BOUNDARY_LIMITS.pathLengthMax) {
            incomplete = true;
            continue;
          }
          if (entry.isDirectory() && entryPath.split('/').length <= DIRECTORY_LEVELS_MAX) {
            pending.push(entryPath);
          } else if (entry.isFile()) {
            if (/\.(?:astro|mdx?)$/i.test(entry.name)) {
              const file = checkedEntry(root, entryPath);
              if (file.kind === 'file') {
                files.push({ path: entryPath, size: file.stat.size, witness: fileWitness(file.stat) });
              } else {
                incomplete = true;
              }
            }
          } else {
            incomplete = true;
          }
        }
      } finally {
        listing.closeSync();
      }
    } catch {
      incomplete = true;
    }
  }
  return { files: files.sort((left, right) => (left.path < right.path ? -1 : left.path === right.path ? 0 : 1)), incomplete: incomplete || remaining === 0 };
}

export function setupEvidenceText(root: string, file: SetupFile) {
  const reading = setupText(root, file.path, SOURCE_BYTES_MAX);
  if (reading.kind === 'text' && reading.witness === file.witness) {
    return reading.text;
  }
  return undefined;
}

export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sourceDirectory(file: string, source: string): { readonly kind: 'unverified' } | { readonly kind: 'verified'; readonly value: string | undefined } {
  const syntax = setupSyntax(file, source);
  const assignment = syntax?.statements.find(ts.isExportAssignment);
  if (assignment === undefined || assignment.isExportEquals) {
    return { kind: 'unverified' };
  }
  const expression = assignment.expression;
  const config =
    ts.isCallExpression(expression) &&
    expression.arguments.length === 1 &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'defineConfig' &&
    syntax?.statements.some(usesAstroDefineConfig)
      ? expression.arguments[0]
      : expression;
  if (config === undefined || !ts.isObjectLiteralExpression(config)) {
    return { kind: 'unverified' };
  }
  let sourceDirectory: string | undefined;
  const seen = new Set<string>();
  for (const property of config.properties) {
    if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
      return { kind: 'unverified' };
    }
    const key = property.name.text;
    if (seen.has(key)) {
      return { kind: 'unverified' };
    }
    seen.add(key);
    if (key === 'root') {
      return { kind: 'unverified' };
    }
    if (key === 'srcDir') {
      if (!ts.isStringLiteralLike(property.initializer)) {
        return { kind: 'unverified' };
      }
      sourceDirectory = projectFolderOfLiteral(property.initializer.text);
      if (sourceDirectory === undefined) {
        return { kind: 'unverified' };
      }
    }
    if (key === 'publicDir' || key === 'outDir' || key === 'cacheDir') {
      if (!ts.isStringLiteralLike(property.initializer) || projectFolderOfLiteral(property.initializer.text) === undefined) {
        return { kind: 'unverified' };
      }
    }
  }
  if (sourceDirectoryFromConfig(source) !== sourceDirectory) {
    return { kind: 'unverified' };
  }
  return { kind: 'verified', value: sourceDirectory };
}

function usesAstroDefineConfig(statement: ts.Statement): boolean {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'astro/config') {
    return false;
  }
  const bindings = statement.importClause?.namedBindings;
  return (
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.some((element) => element.name.text === 'defineConfig' && element.propertyName === undefined && !element.isTypeOnly)
  );
}

export function setupSyntax(file: string, source: string): ts.SourceFile | undefined {
  try {
    const syntax = ts.createSourceFile(file, source, { languageVersion: ts.ScriptTarget.Latest }, false);
    // TypeScript publishes syntax diagnostics on the node, while the public interface omits them.
    const diagnostics: unknown = Reflect.get(syntax, 'parseDiagnostics');
    return Array.isArray(diagnostics) && diagnostics.length === 0 ? syntax : undefined;
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      // Deeply nested source can exhaust TypeScript's parser stack before hitting the byte cap.
      return undefined;
    }
    throw error;
  }
}

type Entry =
  | { readonly kind: 'missing' }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'directory'; readonly absolute: string }
  | { readonly kind: 'file'; readonly absolute: string; readonly stat: fs.Stats };

function checkedEntry(root: string, relative: string): Entry {
  const segments = relative.split('/');
  if (
    segments.length > DIRECTORY_LEVELS_MAX ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes(path.sep))
  ) {
    return { kind: 'blocked' };
  }
  let absolute = root;
  try {
    for (const [index, segment] of segments.entries()) {
      absolute = path.join(absolute, segment);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        continue;
      }
      if (index === segments.length - 1 && stat.isFile()) {
        return { kind: 'file', absolute, stat };
      }
      return { kind: 'blocked' };
    }
    return { kind: 'directory', absolute };
  } catch (error: unknown) {
    return { kind: errorCode(error) === 'ENOENT' ? 'missing' : 'blocked' };
  }
}

type SetupText = { readonly kind: 'missing' | 'blocked' } | { readonly kind: 'text'; readonly text: string; readonly witness: string };

function setupText(root: string, relative: string, bytesMax: number): SetupText {
  const file = checkedEntry(root, relative);
  if (file.kind !== 'file') {
    return { kind: file.kind === 'missing' ? 'missing' : 'blocked' };
  }
  if (file.stat.size > bytesMax) {
    return { kind: 'blocked' };
  }
  try {
    const descriptor = fs.openSync(file.absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const witness = fileWitness(file.stat);
      if (fileWitness(fs.fstatSync(descriptor)) !== witness || fs.realpathSync(file.absolute) !== file.absolute) {
        return { kind: 'blocked' };
      }
      const buffer = Buffer.alloc(file.stat.size + 1);
      const length = fs.readSync(descriptor, buffer, { offset: 0, length: buffer.length, position: 0 });
      if (length !== file.stat.size || fileWitness(fs.fstatSync(descriptor)) !== witness) {
        return { kind: 'blocked' };
      }
      return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)), witness };
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return { kind: 'blocked' };
  }
}

function fileWitness(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
