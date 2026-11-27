// Re-exported from astroCopy.ts so Desktop callers keep their module paths without adding files to Studio's release.
export {
  PROJECT_SETUP_ENTRIES_MAX,
  PROJECT_SETUP_EXAMPLES_MAX,
  PROJECT_SETUP_KINDS,
  parseProjectSetupApply,
  parseProjectSetupResult,
  parseProjectSetupScan,
} from './astroCopy';
export type { ProjectSetupKind, ProjectSetupReport, ProjectSetupScan, ProjectSetupSuggestion } from './astroCopy';
