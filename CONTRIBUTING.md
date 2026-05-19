# Contributing

Thanks for helping improve Universal Code Reviewer.

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

The action runs from `dist/index.js`, so source changes that affect runtime behavior must be bundled with `npm run build` before release.

## Pull Request Guidelines

- Keep changes focused.
- Add tests for parser, command, GitHub API, or review-mapping behavior when possible.
- Update the README when changing user-facing inputs or behavior.
- Do not commit secrets, provider keys, or private endpoint URLs.

## Commit messages (for releases)

Merges to `main` use [Release Please](https://github.com/googleapis/release-please) to bump versions and write release notes. Use [Conventional Commits](https://www.conventionalcommits.org/) in PR titles or squash-merge messages:

| Prefix | Version bump | Example |
| --- | --- | --- |
| `feat:` | Minor | `feat: add provider preset for Groq` |
| `fix:` | Patch | `fix: skip composer.lock in diff filter` |
| `feat!:` or `BREAKING CHANGE:` | Major | `feat!: remove deprecated fail-on-critical input` |

When a release is ready, the **Release** workflow opens or updates a `chore: release X.Y.Z` pull request. Merging it creates the GitHub release, tag, and floating `@v1` / `@v1.0` tags.

**Repository setting (one-time):** In **Settings → Actions → General → Workflow permissions**, choose **Read and write permissions** and enable **Allow GitHub Actions to create and approve pull requests**. Without this, Release Please cannot open release PRs.
