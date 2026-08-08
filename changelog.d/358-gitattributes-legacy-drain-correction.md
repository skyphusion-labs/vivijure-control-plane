### Fixed

- `.gitattributes`: corrected the comment's claim that the committed `CHANGELOG.md
  merge=union` attribute drains the legacy PR queue. It does not. Git reads a file's merge
  attribute from the pre-merge working tree, which during a drain is the PR branch, and
  every legacy PR predates the attribute -- so it is absent at the moment it would apply.
  Documented the recipe that does work (`git -c core.attributesFile=...`, which mutates no
  shared state), the structural checks a dumb union driver still requires, and why draining
  locally is preferable to `gh pr update-branch`. Verified bidirectionally on cp#336.
  Refs cp#358.
