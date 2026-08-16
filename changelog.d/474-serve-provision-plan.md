### fix(onboarding): serve the real provision plan, so review is not empty (cp#474)

The review step called `GET /api/tenant/provision-plan` on every walk of the wizard. **The plane
did not serve that route.** The preview mock invented four RunPod endpoints and answered green, so
the flow was walkable in preview and blank in production, on the last screen before anything is
created.

The route now exists and its body is a projection of `PROVISION_PLAN`, the same array the
provisioner builds from. Own-iron rows carry `backing: "vpc"` and a null worker pin; pooled rows
carry the real GPU list and the pinned max. The review renderer stopped appending
"scale-to-zero" to every row, because half the plan is not a RunPod endpoint.

The go-live POST with no key is now an empty JSON body rather than `runpod_invoke_key:""`. Shared
tier already treated both as empty; sending a named empty field was the one leftover that still
looked like a key form.

cp#439, cp#428, cp#467, cp#447, cp#448, cp#449 and cp#435 were already true at this HEAD. This
closes the one wall that was still standing.

