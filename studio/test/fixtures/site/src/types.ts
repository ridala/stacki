/** Page metadata for `BaseHead` and layouts. */
export interface SeoProps {
  /** Page title. The site name is appended. @seo title */
  title?: string;
  /** Page and social description. Defaults to `SITE_DESCRIPTION`. @seo description */
  description?: string;
  /** Social image. Defaults to `/og-image.jpg`. @seo social-image */
  image?: string;
  /** Open Graph type. */
  type?: "website" | "article";
  /** Override `NOINDEX_ROUTES` for this page's robots tag. @seo noindex */
  noindex?: boolean;
}
