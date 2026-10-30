import { readFileSync } from 'node:fs';

// Read the deployment policy so browser checks cannot drift from Caddy.
const configured = readFileSync(new URL('../../deploy/content-security-policy.caddy', import.meta.url), 'utf8');
const [, header, template] = /^header (Content-Security-Policy(?:-Report-Only)?) "([^"\n]+)"\n$/.exec(configured) ?? [];
if (!template) throw new Error('Cannot read the Caddy content security policy');
const originPattern = /^https:\/\/[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
export function contentSecurityPolicy(extraScriptOrigin = '') {
  if (extraScriptOrigin && (extraScriptOrigin.length > 261
    || extraScriptOrigin.trim() !== extraScriptOrigin || !originPattern.test(extraScriptOrigin))) {
    throw new Error('Expected one HTTPS script origin');
  }
  return template.replaceAll('{$BOARD_CSP_SCRIPT_ORIGIN}', extraScriptOrigin).replace(/ +;/g, ';');
}
export const cspHeader = process.env.BOARD_CSP_REPORT_ONLY === '1'
  ? 'Content-Security-Policy-Report-Only'
  : process.env.BOARD_CSP_REPORT_ONLY === '0' ? 'Content-Security-Policy' : header;
