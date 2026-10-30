### fix(catalog): drop the retired motion doors

`seedance`, `google-veo` and `vidu-q3` leave `TENANT_MODULE_CATALOG` and `PUBLIC_ENDPOINT_ALLOWLIST`. vivijure-cf#1087 retires them, so a release built after it publishes no bundle for them, and `prefetchModuleBundles` would fail a provision on the missing bundle. `kling-o1-r2v` was never in the catalog or the allow-list. The comments that described it as live are corrected, and the declaration count is re-measured at vivijure-cf@375bc86.
