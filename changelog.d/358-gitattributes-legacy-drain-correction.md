### Fixed

- `.gitattributes`: corrected the comment's claim that the committed `CHANGELOG.md
  merge=union` attribute drains the legacy PR queue. It does not. Git reads a file's merge
  attribute from the pre-merge working tree, which during a drain is the PR branch, and
  every legacy PR predates the attribute -- so it is absent at the moment it would apply.
  Documented the repo-local recipe that does work (`--git-common-dir/info/attributes`),
  verified bidirectionally on cp#336, and recorded the two ways the instrument misreports
  this. Refs cp#358.
