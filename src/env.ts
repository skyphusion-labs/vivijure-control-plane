/**
 * Hand-authored Env for the control-plane Worker.
 *
 * MIRROR DISCIPLINE (project standard): every binding declared in wrangler.toml
 * MUST be mirrored here, and vice versa. We deliberately do NOT generate
 * worker-configuration.d.ts (it is gitignored); runtime types come from the
 * pinned @cloudflare/workers-types devDependency.
 *
 * `tsc --noEmit` will NOT catch a binding that exists here but not in
 * wrangler.toml -- only a real `wrangler deploy` fails on a dangling binding.
 * Add bindings to both files in the same commit.
 *
 * The extracted control-plane bindings land here with Rollins tree (cf#85).
 */
export interface Env {
  /** Control-plane D1. Schema is owned by migrations/; never applied by hand. */
  CONTROL_PLANE_DB: D1Database;
}
