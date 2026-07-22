# AGENTS.md

## Cursor Cloud specific instructions

Standard scripts are in `package.json`. Non-obvious VM gotchas:

- **Run the JS toolchain under Node 24.** The VM's default `node` is a wrapper
  (`/exec-daemon/node`, v22.14) that shadows nvm. Keep the workspace on Node 24
  (installed via nvm by the environment update script) so bare-`node` `.ts`
  type-stripping works: `export PATH="$HOME/.nvm/versions/node/v24"*"/bin:$PATH"`.
- **Install deps with the default Node 22 `npm` (v10), not Node 24's `npm` (v11).**
  npm 11 blocks the `esbuild`/`workerd` postinstall (native binaries wrangler and
  vitest need) behind an interactive allow-scripts prompt. Run `npm ci` on the
  default PATH, then run typecheck/test under Node 24.
- `npm run dev` starts `wrangler dev`; deploy needs Cloudflare creds not present here.
  `wrangler.toml` is git-ignored here; copy `wrangler.toml.example` for local dev.

Verified in this environment (Node 24): `npm ci`, `npm run typecheck`,
`npm test` (576 passed, 28 skipped) all pass.
