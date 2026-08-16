### fix(provision): rip Workers VPC; hosted doors are Traefik HTTPS

Tenant studio upload never attaches vpc_service. Own-iron modules
(finish-upscale, speech-upscale) bind FINISH_UPSCALE_DOORS /
SPEECH_UPSCALE_DOORS plus bearer secrets, matching vivijure-cf.
Plan backing is `door`, not `vpc`. Refresh does not re-add VPC;
detach still strips leftovers. No HTTPS list refuses honestly.
