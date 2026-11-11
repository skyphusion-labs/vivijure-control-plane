### fix(provisioner): bind each studio's own module-script prefix

A provisioned studio now carries `TENANT_MODULE_PREFIX`, its own tenant's module-script prefix in the shared module namespace (`tenantModuleScriptPrefix`). The studio's module install accepts only scripts under it (vivijure-cf). New studios get it at upload. An existing studio gets it on its next binding refresh, which sets it rather than inheriting it.
