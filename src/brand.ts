/** Decorative presentation only; keep Robin's text signature independent of this image. */
export const ROBIN_MARK = '<img src="https://www.robinreview.dev/brand/favicon-48.png" width="24" height="24" alt="" />';

/** Accessible linked heading shared by top-level GitHub bodies. */
export const ROBIN_HEADER =
  ROBIN_MARK + ' The <a href="https://www.robinreview.dev/">Robin</a> Hood of code review';

/** Compatibility marker for recognizing Robin reviews, including legacy visible signatures. */
export const ROBIN_SIGNATURE = ":bow_and_arrow: Robin";

/** One heading and hidden recognition marker per top-level GitHub body. */
export function buildRobinHeader(suffix = ""): string {
  return "## " + ROBIN_HEADER + suffix + "\n\n<!-- " + ROBIN_SIGNATURE + " -->";
}
