**What & why**
Briefly: what this changes and the reason.

**Type**
- [ ] Bug fix
- [ ] Feature
- [ ] Docs
- [ ] Refactor / chore

**Verification**
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build` (run before committing — `dist/index.js` is the published bundle)

**Dual entry points** (required when adding/changing an action input)
Robin has two surfaces. Updating only `action.yml` is not enough for most consumers.

- [ ] `action.yml` input added/updated
- [ ] `.github/workflows/review.yml` `workflow_call` input + forward to the action step
- [ ] `.github/robin.yml` / repo-config parser (if the knob should be set without a workflow edit)
- [ ] `docs/ADVANCED.md` + example if user-facing
- [ ] `testdata/consumer-workflows/all-inputs.yml` updated (actionlint + Jest parity)

**Notes**
Breaking change? Migration needed? Anything reviewers should focus on?
