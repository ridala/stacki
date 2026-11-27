// Fork releases opt in here so a packaged build cannot inherit an upstream service.
export const DESKTOP_RELEASE: {
  /** Full URL of the daily counter's POST endpoint. */
  readonly usageCountsURL: `https://${string}` | undefined;
  /** Base URL serving electron-builder's channel manifests and installer files. */
  readonly updateFeedURL: `https://${string}` | undefined;
} = {
  usageCountsURL: undefined,
  updateFeedURL: undefined,
};
