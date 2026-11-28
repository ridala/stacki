import fs from 'node:fs';
export { writeProjectText } from '../documents/documentWrites';
export {
  discoverImportedStylesheets,
  isLibraryVariableFile,
  resolveEditableVariableFile,
  resolveLibrarySourceFile,
  type ImportedStylesheet,
  type LibrarySourceMatch,
} from './cssVarImports';
export const variableFiles = {
  readFileSync: (file: string, encoding: 'utf8') => fs.readFileSync(file, encoding),
  readdirSync: (directory: string, options: { readonly withFileTypes: true }) => fs.readdirSync(directory, options),
  statSync: (file: string) => fs.statSync(file),
};
