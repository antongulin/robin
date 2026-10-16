# Robin artwork

The website owns the source masters and deterministic export pipeline. Use the
public [brand downloads](https://www.robinreview.dev/brand/) for the full original,
compact head, icons and social cards. This directory keeps two small exports copied
byte for byte from the website build; core needs no image-generation dependency.

| Copy | Dimensions | Bytes | Usage |
| --- | --- | --- | --- |
| [`mascot-320.webp`](mascot-320.webp) | 320×320 | 15,770 | Full-bird introductory artwork; display around 160–200px |
| [`favicon-48.png`](favicon-48.png) | 48×48 | 4,941 | Compact head beside a text label; display at 24–32px |

README and GitHub body images use stable absolute URLs under
`https://www.robinreview.dev/brand/`, so GitHub and npm can resolve them. Keep
descriptive alt text for standalone artwork and empty alt text for decorative marks
beside a label. Fixed-size marks should use explicit pixel dimensions; responsive
banners should fill their container while preserving intrinsic proportions, without
a forced height. All action-authored top-level GitHub bodies, including progress,
final statuses and help, share one decorative bird followed by plain ` The `,
linked `Robin`, and plain ` Hood of code review`. Only `Robin` is clickable;
the decorative image stays outside the link with empty alt text. The link points to
`https://www.robinreview.dev/`; a summary may add its suffix. Each body keeps
`:bow_and_arrow: Robin` once in a hidden HTML comment for legacy recognition.
Inline findings use plain labels without images or taglines. Terminal prefixes use
plain `Robin:`. This presentation does not change the GitHub account posting a review.

To refresh these copies, take the same-named files from the website's generated
`dist/brand/` after a successful build and delivery. Copy the creative prompt from
its source assets, then verify dimensions, byte equality and these SHA256 values:

```text
2c21d627f5168b197583853856f50e2b5c0fbd456e9773837a990a094896e02c  mascot-320.webp
d0ecb628005d556054a098f9b4e1ae489a8b0b566f42b127dc8b75e0fe0377d6  favicon-48.png
33ef165c14c4e71a965659556bbd972a3ee51e9eb089d38b0400fbfc16a8bb1c  mascot-head-prompt.txt
```

## Historical screenshots

[`../robin-review.png`](../robin-review.png) and
[`../robin-review-clean.png`](../robin-review-clean.png) preserve earlier GitHub
output with visible bow headings and the former promotional footer. They are
historical captures, not examples of current output, and their original bytes
remain unchanged. The current README uses a Markdown output sample instead.

```text
8a082b9108903fbf3b6c8f0e86789029eebcad8767c296c55ac5a291e0a11ae7  robin-review.png
a14d9dc76dce8c0b79a5aa02c7b3e0e7543d4a0e22a08c6dfa6a48384a39f3a0  robin-review-clean.png
```

## Source credits

[shadowhand](https://github.com/shadowhand) offered the Gemini-generated original
2048×2048 transparent bird under [CC0](https://creativecommons.org/publicdomain/zero/1.0/)
in [Robin issue #101](https://github.com/antongulin/robin/issues/101).
The [original attachment](https://github.com/user-attachments/assets/199c409b-d470-46c0-9078-f3a83d5fab29)
and [public original PNG](https://www.robinreview.dev/brand/mascot.png) have SHA256
`31fec21b2fae66dcba76088eb7bb6e10f9943ab706dd37fdce5cbf596931fef6`.
The WebP copy preserves that bird's square composition and transparency.

The compact head is a separate OpenAI ImageGen adaptation of the original, created
on 2026-10-15. Its 1254×1254 transparent master has SHA256
`fb5ae8d011f99ad0779b6c9107878d6abaf6c6f0247ab1b80b280f2986312a6b`.
The exact creative edit prompt is [`mascot-head-prompt.txt`](mascot-head-prompt.txt).
The [public head PNG](https://www.robinreview.dev/brand/mark.png) and smaller exports
come from that adaptation. The contributor's CC0 offer concerns the original bird;
the head adaptation has this separate provenance.
