import { useId, useRef, useState } from 'react';
import type { Attr } from '../../../shared/page/pageNode';
import { LIMITS } from '../../../shared/core/limits';
import { useTranslate } from '../../lib/i18n/useTranslate';
import Dropdown from '../../ui/Dropdown';
import { ErrorToast } from '../../ui/ErrorToast';
import { validSeoText, type Indexing, type SeoField, type SeoRole } from './pageSeo';

const LABELS = {
  title: 'pages.settings.seo.title',
  description: 'pages.settings.seo.description',
  'social-image': 'pages.settings.seo.socialImage',
  'social-image-alt': 'pages.settings.seo.socialImageAlt',
  canonical: 'pages.settings.seo.canonical',
  noindex: 'pages.settings.seo.indexing',
} as const satisfies Record<SeoRole, string>;

type WriteField = (name: string, value: Attr | undefined) => void;

export function PageSeoFields({
  owner,
  fields,
  reason,
  write,
}: {
  readonly owner: string;
  readonly fields: readonly SeoField[];
  readonly reason?: string | undefined;
  readonly write: WriteField | undefined;
}) {
  const translate = useTranslate();
  if (fields.length === 0) {
    return <div className="page-settings-note">{reason ?? translate('pages.settings.seo.unavailable')}</div>;
  }
  return fields.map((field) => {
    const label = translate(LABELS[field.role]);
    if (field.value.kind === 'bound') {
      return (
        <div className="page-settings-field" key={field.name}>
          <span>{label}</span>
          <div className="page-settings-note">{translate('pages.settings.seo.bound')}</div>
        </div>
      );
    }
    if (field.value.kind === 'indexing') {
      return <IndexingField key={field.name} field={field} label={label} value={field.value.indexing} write={write} />;
    }
    return (
      <TextField key={JSON.stringify([owner, field.role, field.name, field.value.text])} field={field} label={label} text={field.value.text} write={write} />
    );
  });
}

function IndexingField({
  field,
  label,
  value,
  write,
}: {
  readonly field: SeoField;
  readonly label: string;
  readonly value: Indexing;
  readonly write: WriteField | undefined;
}) {
  const translate = useTranslate();
  return (
    <div className="page-settings-field">
      <span>{label}</span>
      <Dropdown<Indexing>
        ariaLabel={label}
        disabled={write === undefined}
        value={value}
        options={[
          { value: 'inherit', label: translate('pages.settings.seo.inherit'), disabled: !field.optional },
          { value: 'index', label: translate('pages.settings.seo.index') },
          { value: 'noindex', label: translate('pages.settings.seo.noindex') },
        ]}
        onChange={(next) => {
          if (next !== value && (next !== 'inherit' || field.optional)) {
            write?.(field.name, next === 'inherit' ? undefined : { type: 'expr', value: next === 'noindex' ? 'true' : 'false' });
          }
        }}
      />
    </div>
  );
}

function TextField({
  field,
  label,
  text,
  write,
}: {
  readonly field: SeoField;
  readonly label: string;
  readonly text: string | undefined;
  readonly write: WriteField | undefined;
}) {
  const translate = useTranslate();
  const id = useId();
  const [draft, setDraft] = useState(text ?? '');
  const resetButton = useRef<HTMLButtonElement>(null);
  const invalid = draft !== (text ?? '') && !validSeoText(field.role, draft);
  return (
    <div className="page-settings-field">
      <label htmlFor={id}>{label}</label>
      <input
        className="page-settings-seo-input"
        id={id}
        value={draft}
        disabled={write === undefined}
        maxLength={LIMITS.attrCharsMax}
        placeholder={field.optional ? translate('pages.settings.seo.inherit') : undefined}
        aria-invalid={invalid}
        title={invalid ? translate('pages.settings.seo.invalidCanonical') : undefined}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={(event) => {
          if (resetButton.current !== null && event.relatedTarget === resetButton.current) {
            return;
          }
          if (!invalid && draft !== (text ?? '')) {
            write?.(field.name, { type: 'string', value: draft });
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
      />
      <ErrorToast message={invalid ? translate('pages.settings.seo.invalidCanonical') : undefined} />
      {field.optional && text !== undefined && write !== undefined && (
        <button type="button" className="page-settings-add-prop" ref={resetButton} onClick={() => write(field.name, undefined)}>
          {translate('pages.settings.seo.inherit')}
        </button>
      )}
    </div>
  );
}
