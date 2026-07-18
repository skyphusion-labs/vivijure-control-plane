// The R2 credential seam (#53), split out on the integration ruling.
//
// WHY ITS OWN SEAM: minting the per-tenant, bucket-scoped R2 credential is the ONE provisioning
// capability our API-created provisioner token cannot perform. Cloudflare refuses API-created
// tokens any token-management rights ("sub-token is not allowed to have permissions to manage
// other tokens"), so this needs a DASHBOARD-created credential. That is a cred problem, not a code
// problem, and it is confined here so the other six provisioning legs are live-verifiable today
// instead of being held hostage to it. Asserted, not assumed: tests/control-plane/cf-api.live.test.ts
// proves the mint really is refused, and that negative control flips the day the right cred lands.
//
// PARKED (do NOT build toward it yet; it is a contract change and parity-bound): per-job temporary
// R2 credentials via the R2 temp-access-credentials API, so tenant-readable RunPod templates would
// carry no long-lived creds at all. Noted here so the intent is not lost, not as a TODO to action.

import type { CfApi } from "./cf-api";

/** A minted credential. The VALUE is a secret: it goes straight into a worker secret and is dropped. */
export interface MintedR2Credential {
  /** The token id. Safe to store: teardown revokes by it. */
  id: string;
  /** The token value. NEVER stored, never logged, never returned to a caller. */
  value: string;
}

export interface TokenMinter {
  mintBucketToken(name: string, bucket: string): Promise<MintedR2Credential>;
  revoke(tokenId: string): Promise<void>;
}

/**
 * R2's bucket-scoped permission groups. Stable CF ids, deploy-independent, not secrets.
 * BOTH are required: a render reads and writes its own bucket. These are the real ids, read off
 * the account's permission-groups endpoint rather than guessed.
 */
export const R2_BUCKET_ITEM_READ = "6a018a9f2fc74eb6b293b0c548f38b39";
export const R2_BUCKET_ITEM_WRITE = "2efd5506f9c8494dacb1fa10a3e7d5b6";

/** The real minter. */
export class CfTokenMinter implements TokenMinter {
  constructor(
    private readonly cf: CfApi,
    private readonly permissionGroupIds: string[] = [R2_BUCKET_ITEM_READ, R2_BUCKET_ITEM_WRITE],
  ) {}

  async mintBucketToken(name: string, bucket: string): Promise<MintedR2Credential> {
    return await this.cf.mintR2Token(name, bucket, this.permissionGroupIds);
  }

  async revoke(tokenId: string): Promise<void> {
    await this.cf.revokeToken(tokenId);
  }
}
