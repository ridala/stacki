import { assert } from '../core/assert';
import { boolean, object, record, text } from '../core/boundary';
import { err, ok, type Result } from '../core/result';
import { parseAbsolutePath } from './astroCopy';

export const parseShadcnSettingsRequest = object({ projectPath: parseAbsolutePath });
export const parseShadcnSettingsChange = object({ projectPath: parseAbsolutePath, setting: parseSetting, enabled: boolean });
const parseSettings = object({ pointer: boolean, rtl: boolean });
const parseError = object({ message: text });

export type ShadcnSettings = ReturnType<typeof parseSettings>;
export type ShadcnSettingsChange = ReturnType<typeof parseShadcnSettingsChange>;
export type ShadcnSettingsReply = Result<ShadcnSettings | undefined, { readonly message: string }>;

export function parseShadcnSettingsReply(input: unknown): ShadcnSettingsReply {
  const fields = record(input);
  if (!boolean(fields['ok'])) {
    const error = parseError(fields['error']);
    assert(typeof error.message === 'string', 'Shadcn settings error must carry a message');
    return err(error);
  }
  const value = fields['value'] === undefined ? undefined : parseSettings(fields['value']);
  if (value !== undefined) {
    assert(typeof value.pointer === 'boolean', 'Shadcn pointer setting must be boolean');
    assert(typeof value.rtl === 'boolean', 'Shadcn rtl setting must be boolean');
  }
  return ok(value);
}

function parseSetting(input: unknown): 'pointer' | 'rtl' {
  if (input === 'pointer' || input === 'rtl') {
    assert(input.length > 0, 'Shadcn setting key must be non-empty');
    return input;
  }
  throw new Error('Unknown shadcn setting.');
}
