// Secrets (wrangler secret put / .dev.vars) are not in wrangler.jsonc, so
// `wrangler types` cannot see them. OAUTH_PROVIDER is injected by OAuthProvider.
interface FlashEnvExtras {
  MCP_RESOURCE: string;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}
interface Env extends FlashEnvExtras {}
declare namespace Cloudflare {
  interface Env extends FlashEnvExtras {}
}
