import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { Attr, PairedNode } from '../../../shared/page/pageNode';
import { PROP_TAG_LIMITS } from '../../../shared/properties/propTags';
import type { PropField } from '../../../shared/properties/propSchema';

// The author marks the props that the layout actually forwards into the head.
const SEO_ROLES = ['title', 'description', 'social-image', 'social-image-alt', 'canonical', 'noindex'] as const;

export type SeoRole = (typeof SEO_ROLES)[number];
export type Indexing = 'inherit' | 'index' | 'noindex';

export interface SeoField {
  readonly role: SeoRole;
  readonly name: string;
  readonly optional: boolean;
  readonly value:
    { readonly kind: 'bound' } | { readonly kind: 'text'; readonly text: string | undefined } | { readonly kind: 'indexing'; readonly indexing: Indexing };
}

export function pageSeoFields(schema: readonly PropField[], layout: PairedNode): readonly SeoField[] {
  assert(schema.length <= LIMITS.propSchemaFieldsMax, 'SEO: the layout schema is bounded');
  const candidates = schema.map((field) => ({ field, role: seoRole(field.doc) }));
  const hasSpread = Object.values(layout.props ?? {}).some((attribute) => attribute.type === 'spread');
  const fields = SEO_ROLES.flatMap((role) => {
    const matches = candidates.filter((candidate) => candidate.role === role);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match === undefined || match.field.usage === 'unread' || match.field.unions !== undefined || match.field.name === 'class') {
      return [];
    }
    const field = match.field;
    if (field.type !== (role === 'noindex' ? 'boolean' : 'string')) {
      return [];
    }
    const attribute = layout.props?.[field.name];
    const unsafe = hasSpread || (layout.attrOrder?.filter((name) => name === field.name).length ?? 0) > 1;
    const value: SeoField['value'] = unsafe ? { kind: 'bound' } : seoValue(role, attribute);
    return [{ role, name: field.name, optional: field.optional === true, value }];
  });
  assert(fields.length <= SEO_ROLES.length, 'SEO: each role has at most one field');
  return fields;
}

function seoRole(documentation: string | undefined): SeoRole | undefined {
  if (documentation === undefined || documentation.length > PROP_TAG_LIMITS.docCharsMax) {
    return undefined;
  }
  const tags = [...documentation.matchAll(/(?:^|\s)@seo\b([^@]*)/g)];
  const name = tags.length === 1 ? tags[0]?.[1]?.trim() : undefined;
  return SEO_ROLES.find((role) => role === name);
}

function seoValue(role: SeoRole, attribute: Attr | undefined): SeoField['value'] {
  if (role === 'noindex') {
    if (attribute === undefined) {
      return { kind: 'indexing', indexing: 'inherit' };
    }
    if (attribute.type === 'bare' || (attribute.type === 'expr' && attribute.value === 'true')) {
      return { kind: 'indexing', indexing: 'noindex' };
    }
    if (attribute.type === 'expr' && attribute.value === 'false') {
      return { kind: 'indexing', indexing: 'index' };
    }
  } else {
    if (attribute === undefined || attribute.type === 'string') {
      return { kind: 'text', text: attribute?.value };
    }
  }
  return { kind: 'bound' };
}

export function validSeoText(role: SeoRole, value: string): boolean {
  if (value.length > LIMITS.attrCharsMax) {
    return false;
  }
  if (role !== 'canonical') {
    return true;
  }
  const url = URL.parse(value);
  return url !== null && /^https?:\/\//i.test(value) && !value.includes('#') && url.username === '' && url.password === '';
}
