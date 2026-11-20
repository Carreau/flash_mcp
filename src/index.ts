import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { authHandler } from "./auth/authorize";
import { Store } from "./db/store";
import { buildServer } from "./mcp";

type Props = { userId: string };

const resource = env.MCP_RESOURCE;
if (!URL.canParse(resource) || resource.includes("<")) {
  throw new Error(`MCP_RESOURCE must be the public /mcp URL (wrangler.jsonc vars), got "${resource}"`);
}
const origin = new URL(resource).origin;

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      // OAuthProvider only calls this with a valid token; props are what /authorize stored.
      const { userId } = ctx.props as Props;
      const store = new Store(env.DB, userId);
      // Stateless: a fresh server per request, bound to the signed-in user.
      return createMcpHandler(() => buildServer(store))(request, env, ctx);
    },
  },
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: { resource, authorization_servers: [origin] },
  // Stay signed in while the connector is in use; expire after 90 idle days.
  refreshTokenIdleTTL: 90 * 86_400,
});
