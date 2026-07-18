// Wrangler Text-module imports (wrangler.control-plane.toml [[rules]] type = "Text"): a .sql import
// resolves to the file text at build time.
declare module "*.sql" {
  const text: string;
  export default text;
}
