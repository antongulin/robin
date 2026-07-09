# Contributing

Thanks for helping improve Robin.

## Good First Areas

- Prompt quality and reviewer output examples.
- Parser reliability and schema validation.
- GitHub review comment mapping.
- Provider setup examples.
- Large pull request handling.
- Documentation clarity.

## Development

```bash
npm ci
npm run lint
npm test
npm run build
```

The action runs from `dist/index.js`, so source changes that affect runtime behavior must be bundled with `npm run build` before release. The build removes intermediate `dist/` files automatically (`scripts/clean-dist.js`, plain Node — works on Windows); only `dist/index.js` is committed. Run `npm run clean` manually if you ran `tsc` without a full build.

Maintainer-only paths (`docs/superpowers/`, `.agents/`) are gitignored so the public repo stays focused on the action and user docs (`README.md`, `docs/ADVANCED.md`, `AGENTS.md`).

## Testing prompt changes

Robin must give good reviews on weak, free, and randomly-routed models, not just strong
ones (see [Model robustness](docs/ADVANCED.md#model-robustness)). A prompt tweak that
helps a strong model can quietly regress a weak one, so test against more than one:

- Run the same PR through **at least 2–3 different free models** (e.g. swap `LLM_MODEL`
  between a few OpenRouter free models, or point `LLM_BASE_URL` at a local Ollama model).
- Check the failure modes the prompt defends against: are inline comments anchored to the
  right lines, is severity calibrated (not everything HIGH), does JSON mode still parse,
  and does the markdown fallback still work when it doesn't?
- Prefer a real PR with a known mix of issues over a synthetic one — it exercises severity
  and confidence calibration more honestly.

## Pull Request Guidelines

- Keep changes focused.
- Add tests for parser, command, GitHub API, or review-mapping behavior when possible.
- Update the README when changing user-facing inputs or behavior.
- Do not commit secrets, provider keys, or private endpoint URLs.

### Dual entry points (action inputs)

Most consumers call the reusable workflow, not the action directly:

```yaml
uses: antongulin/robin/.github/workflows/review.yml@main
```

When you add or change an action input:

1. Declare it in `action.yml`.
2. Declare it under `on.workflow_call.inputs` in `.github/workflows/review.yml` and forward it to the action step.
3. If it should be settable without editing the workflow, parse it in `.github/robin.yml` (see `src/repo-config.ts`).
4. Document it in `docs/ADVANCED.md`.
5. Update `testdata/consumer-workflows/all-inputs.yml` so actionlint + the Jest parity test stay green.

CI runs [actionlint](https://github.com/rhysd/actionlint) on workflows and that consumer fixture — the same class of error GitHub returns for an undeclared `with:` input.

## Commit messages (for releases)

Merges to `main` use [Release Please](https://github.com/googleapis/release-please) to bump versions and write release notes. Use [Conventional Commits](https://www.conventionalcommits.org/) in PR titles or squash-merge messages:

| Prefix | Version bump | Example |
| --- | --- | --- |
| `feat:` | Minor | `feat: add provider preset for Groq` |
| `fix:` | Patch | `fix: skip composer.lock in diff filter` |
| `feat!:` or `BREAKING CHANGE:` | Major | `feat!: remove deprecated fail-on-critical input` |

When a release is ready, the **Release** workflow opens or updates a `chore: release X.Y.Z` pull request. Release PRs are verified, merged, and published automatically by the workflow. The workflow creates the GitHub release, exact tag, and floating `@v1` / `@v1.0` tags without a manual maintainer merge.

**Repository setting (one-time):** In **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions** and enable **Allow GitHub Actions to create and approve pull requests**. Without this, Release Please cannot open or merge release PRs.
