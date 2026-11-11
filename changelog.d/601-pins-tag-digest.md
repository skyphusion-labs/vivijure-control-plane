### fix(pins): tenant image pins mirror the live hosted endpoints, as tag@digest (#601)

Both satellite pins mirrored endpoints that no longer exist: backend `1.0.13` on `t9wcvlxh8rc5la`, and upscale `1.0.4` on `4q8idwbk6tyqbq`. They now mirror the live hosted endpoints, read 2026-11-11: backend `vivijure-backend:1.1.18` on `xe5d1ivs40ohjo`, and upscale `vivijure-upscale:1.1.3` on `0m7puc409hqw8a`.

`SatellitePin` now requires a manifest `digest`. `imageRef()` emits `<repo>:<tag>@<digest>`, the exact form production templates carry, so a new tenant template is immutable.

- `check:pins` fails when a tag no longer resolves to its pinned digest, and when a pin is missing its digest.
- `check:pins:prod` compares tag@digest, and reads an endpoint image inline when the endpoint carries no template id.

The provisioning e2e's production tell was the literal `t9wcvlxh8rc5la`. That endpoint no longer exists, so the tell matched nothing, and a production RunPod key would have read as scratch. The tell now derives from the pins' mirrored endpoints. The plane is out of service (#574), so no tenant is provisioned on these pins until it returns.
