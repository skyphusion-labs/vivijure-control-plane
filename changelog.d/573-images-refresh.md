### fix(bindings): an existing studio gets the Images binding on refresh (cp#573)

`refreshTenantStudioBindings` now sets `IMAGES` (`{ type: "images" }`) on every refresh, like `TENANT_MODULE_PREFIX`, instead of inheriting only what a studio already had. So a studio provisioned before #603 gets the thumbnail route's binding with no re-upload. The settings PATCH accepts the `images` kind under Workers Scripts Write, per the API spec.
