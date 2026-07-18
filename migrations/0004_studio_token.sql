-- Per-tenant STUDIO_API_TOKEN, encrypted (#40 hosted tier; dispatcher-injected auth 2026-07-18).
--
-- The control plane injects each tenant's studio token at the dispatch layer, so it must hold the
-- token VALUE -- the one credential here not stored as a hash. It is AES-256-GCM encrypted under the
-- STUDIO_TOKEN_KEK worker secret (token-crypto.ts) before it lands here; a D1 dump without the KEK
-- is useless.
ALTER TABLE tenants ADD COLUMN studio_token_enc TEXT;
