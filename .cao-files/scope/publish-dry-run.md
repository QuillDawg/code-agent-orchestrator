# publish-dry-run

Prepare the beta release without publishing anything.

- Set the version to `0.1.0-beta.1` in `package.json` and `package-lock.json`; rename the
  CHANGELOG heading to `## [0.1.0-beta.1] - <today>`.
- Run `npm run build` and `npm pack --dry-run`; confirm `dist/`, README, CHANGELOG, LICENSE,
  docs (without research) and examples are included and nothing else.
- Run `npm publish --dry-run --tag beta`; put its output summary in `summary`.
- Commit with `chore(release): 0.1.0-beta.1`. Do not tag, push or publish.
- In `followUp`, list the exact commands the maintainer runs next:
  `git tag v0.1.0-beta.1`, `git push --follow-tags`, `npm publish --tag beta`.
