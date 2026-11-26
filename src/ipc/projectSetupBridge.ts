import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseProjectSetupResult, type ProjectSetupKind, type ProjectSetupScan } from '../../shared/ipc/projectSetup';

/** Studio and older Desktop bridges can share the UI without exposing the setup channels. */
export function hasProjectSetupChannels(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const bridge = window.avb;
  return (
    typeof bridge === 'object' &&
    Boolean(bridge) &&
    Object.hasOwn(bridge, 'scanProjectSetup') &&
    typeof bridge.scanProjectSetup === 'function' &&
    Object.hasOwn(bridge, 'applyProjectSetup') &&
    typeof bridge.applyProjectSetup === 'function'
  );
}

export async function scanProjectSetup(request: ProjectSetupScan) {
  const payload = parseIpcPayload('project:setupScan', request);
  return parseProjectSetupResult(await window.avb.scanProjectSetup(payload));
}

export async function applyProjectSetup(request: { readonly projectPath: string; readonly revision: string; readonly kinds: readonly ProjectSetupKind[] }) {
  const payload = parseIpcPayload('project:setupApply', request);
  return parseProjectSetupResult(await window.avb.applyProjectSetup(payload));
}
