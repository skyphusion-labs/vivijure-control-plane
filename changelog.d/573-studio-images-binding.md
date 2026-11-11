### fix(provisioner): bind Cloudflare Images on each studio (cp#573)

A provisioned studio now carries `IMAGES` (`{ type: "images" }`), so its still thumbnail route `GET /api/thumb` (vivijure-cf#1211) works instead of answering 503. It is not in the verify census: a studio without it still renders. A studio provisioned before this gets it on its next re-upload.
