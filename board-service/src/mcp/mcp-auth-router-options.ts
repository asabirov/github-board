import type { AuthRouterOptions } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { McpOAuthProvider } from './mcp-oauth.provider';

/**
 * What board hands the SDK's OAuth router (#456).
 *
 * It lives in a file of its own rather than in `main.ts`, and that is the whole
 * reason it exists as a function. It used to be an object literal inside the
 * `if (BOARD_MCP_ENABLED)` block, which no test could import — and `main.ts`
 * ends `void bootstrap()`, so importing it to reach the literal would start a
 * server. A test that rebuilt the options inline instead would assert the SDK's
 * behaviour and stay green even if `main.ts` had stopped passing the provider
 * altogether, which is exactly the mount this arrangement is meant to pin.
 *
 * The endpoints the router derives from this are all at the root: `/authorize`,
 * `/token`, `/register` and — once the provider implements `revokeToken` —
 * `/revoke`. `main.ts` excludes only `mcp` from the global `api` prefix, and
 * this router is mounted with `app.use` before it, so none of the four sit
 * under `/api`.
 *
 * One interop cost worth naming so it is not read as a bug: `router.js:53`
 * advertises `revocation_endpoint_auth_methods_supported: ['client_secret_post']`
 * whenever a revocation endpoint exists, with no way to override it, even though
 * board issues no client a secret. The token endpoint's equivalent does include
 * `'none'`. That is the price of every client being public, not a defect here.
 */
export function mcpAuthRouterOptions(provider: McpOAuthProvider, base: URL): AuthRouterOptions {
  return {
    provider,
    issuerUrl: base,
    resourceServerUrl: new URL('/mcp', base),
    resourceName: 'board',
    scopesSupported: ['agent', 'full'],
  };
}
