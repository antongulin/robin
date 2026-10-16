# <img src="https://www.robinreview.dev/brand/favicon-48.png" width="32" height="32" alt="" /> Contributing

Thanks for helping improve Robin.

For artwork, use the [brand downloads](https://www.robinreview.dev/brand/) and
[source credits](docs/assets/brand/README.md). The website owns the masters and
export pipeline; this repository keeps two compact copies for documentation.

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

When a release is ready, the **Release** workflow opens or updates a `chore: release X.Y.Z` pull request. A maintainer supplies the required approval. The workflow verifies approved release PRs and can squash-merge them under the existing branch rules; a maintainer can also merge through GitHub. After the merge, the workflow publishes the GitHub release and exact tag, updates eligible floating tags, and dispatches npm publication at that exact release tag.

### Release approval and recovery

The Release workflow runs on `main`. It validates the release PR's repository,
GitHub Actions bot identity, expected Release Please branch, base branch, labels,
state, and immutable commit before it checks out release code. A separate job runs
installation, lint, tests, and the bundle comparison with read-only permissions and
no persisted Git credentials. The publication job runs control code from the workflow
revision, rather than scripts from the release tree.

The workflow verifies an open PR's immutable head with read-only permissions even
while approval is pending. After successful verification, an open PR without
approval produces a successful **WAITING** summary and skips merge and publication.
Review the current release PR and its verification results, then approve
and squash-merge it through GitHub. The ensuing main push finds that PR by its
exact merge SHA and resumes publication. If you approve and rerun Release while
the PR remains open, automation can merge it with `--match-head-commit` after
verification. The workflow does not bypass approval or enable auto-merge.

If publication failed after the merge, run **Release → Run workflow** on **main**
and enter the release PR number in `release-pr`. CLI equivalent:

```bash
gh workflow run release.yml --ref main -f release-pr=110
```

The number is an example; use the PR for the release you intend to resume.
Recovery reads the immutable merge commit from GitHub, confirms that it belongs
to main, and verifies that tree. A deleted Release Please branch needs no
restoration. The control helper survives checkout even when the historical tree
does not contain it. A rerun uses the original workflow revision; use a fresh
dispatch on main when recovering a run that predates this recovery implementation.

If a squash merge incorporates changes outside the tested head tree, publication
fails with a recovery instruction. Dispatch again with that PR number so the
read-only verification job checks the actual merged tree before publication.
Changed heads, unexpected API/merge failures, tag mismatches, and failed checks
remain failures; they do not become approval waits.

Matching existing releases are safe to resume. Recovery checks the exact tag's
commit, preserves newer floating-tag streams, and dispatches npm for the intended
release tag rather than moving main. The npm workflow rejects a tag/package-version
mismatch and skips a version that already exists on npm. Check both the GitHub
release and npm run before declaring delivery complete. Keep credentials and
branch protection unchanged; do not create tags or releases by hand.

The repository must allow GitHub Actions to create pull requests. The workflow
declares its job permissions; maintainers still supply required reviews.
