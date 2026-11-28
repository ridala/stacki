// Re-exported from astroCopy.ts so Desktop callers keep their module paths without adding files to Studio's release.
export {
  PROJECT_SETUP_ENTRIES_MAX,
  PROJECT_SETUP_EXAMPLES_MAX,
  PROJECT_SETUP_FINDINGS_MAX,
  PROJECT_SETUP_FINDING_CODES,
  PROJECT_SETUP_FINDING_FILES_MAX,
  PROJECT_SETUP_FINDING_SEVERITIES,
  PROJECT_SETUP_KINDS,
  PROJECT_SETUP_PROMPT_CHARS_MAX,
  WORKSPACE_ASTRO_APPS_MAX,
  buildProjectSetupPrompt,
  parseProjectSetupApply,
  parseProjectSetupResult,
  parseProjectSetupScan,
} from './astroCopy';
export type {
  ProjectSetupFinding,
  ProjectSetupFindingCode,
  ProjectSetupFindingSeverity,
  ProjectSetupKind,
  ProjectSetupReport,
  ProjectSetupScan,
  ProjectSetupSuggestion,
  WorkspaceAstroApp,
} from './astroCopy';
