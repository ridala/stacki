// Renderer bridge for project-aware AI toolkit inspection (`mcp:toolkit`) and
// installing recommended `SKILL.md` files from panels outside `features/instructions/`.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseInstructionWriteResult, type InstructionWriteResult } from '../../shared/properties/instructions';
import { parseProjectAiToolkit, type ProjectAiToolkit } from '../../shared/properties/mcp';

/** Studio and older Desktop bridges may share UI without exposing `readMcpToolkit`. */
export function hasAiToolkitChannel(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const bridge = window.avb;
  return typeof bridge === 'object' && Boolean(bridge) && Object.hasOwn(bridge, 'readMcpToolkit') && typeof bridge.readMcpToolkit === 'function';
}

/** Reads detected UI ecosystems, MCP/skill status, and `@shadcn/lint` status for `projectPath`. */
export async function readProjectAiToolkit(projectPath: string): Promise<ProjectAiToolkit | undefined> {
  if (!hasAiToolkitChannel()) {
    return undefined;
  }
  const payload = parseIpcPayload('mcp:toolkit', { projectPath });
  try {
    return parseProjectAiToolkit(await window.avb.readMcpToolkit(payload));
  } catch (error: unknown) {
    if (error instanceof Error && /No handler registered/.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

/** Creates a recommended `SKILL.md` file through the standard non-overwriting instruction channel. */
export async function createRecommendedSkillFile(projectPath: string, file: string, source: string): Promise<InstructionWriteResult> {
  const payload = parseIpcPayload('instructions:create', { projectPath, file, source });
  return parseInstructionWriteResult(await window.avb.createInstruction(payload));
}
