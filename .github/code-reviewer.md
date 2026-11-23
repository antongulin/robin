# Reviewer Rules

- Prioritize correctness, security, and workflow safety over style.
- Treat parser regressions, lost review findings, and unsafe GitHub event handling as medium or high severity issues.
- Keep feedback concise and actionable.
- Do not comment on the generated `dist/index.js` bundle. It is left out of the diff and of your tools, and CI checks that it matches a fresh `npm run build`.
