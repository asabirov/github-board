/**
 * The board's API reference (#343). A minimal, scannable reference for the
 * read-only REST surface: auth, scopes, and the endpoints, grouped. Its
 * structured jump-nav is the area panel's left rail (#712); this renders the
 * body, each section carrying a `data-docs-section` anchor the rail scrolls to
 * and the scroll-spy highlights.
 *
 * Content is driven from docs-data.ts. The board also speaks MCP over HTTP but
 * exposes no tools yet, so the MCP block says so plainly and points back to REST.
 */

import { ReactNode } from 'react';
import { PageHeading, PAGE_RAIL, PAGE_READING } from '../ui/PageHeading';
import { AREA_LABEL } from '../area-panel/panel';
import { BLOCK } from '../ui/block';
import { copyToClipboard } from '../ui/clipboard';
import { CopyIcon } from '../icons';
import { API_BASE, DOC_GROUPS, DocEndpoint, EndpointScope, McpTool, MCP_TOOLS, Method } from './docs-data';

// The shared app rail with the reference prose narrowed inside it (#450) — Docs
// used to centre its own 880px column, which put its H1 in a different place than
// every other page's.
const ROOT = `${PAGE_RAIL} pb-24 pt-[26px] max-[900px]:pt-4`;
const COLUMN = PAGE_READING;

/** Wraps a section with the anchor the sidebar jump-nav targets + scroll-spy reads.
 *  scroll-mt clears the sticky top bar when a sidebar jump-link scrolls here. */
function Section({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section id={`docs-${id}`} data-docs-section={id} className="scroll-mt-[84px]">
      {children}
    </section>
  );
}

/** A section label — the block-header treatment, with an optional scope tag. */
function SectionHead({ label, scope }: { label: string; scope?: EndpointScope }) {
  return (
    <div className="mb-3 mt-9 flex items-baseline gap-2.5">
      <h2 className="text-[13px] font-semibold tracking-[-0.005em] text-dim">{label}</h2>
      {scope && <ScopeTag scope={scope} />}
    </div>
  );
}

const METHOD_CLS: Record<Method, string> = {
  // GET reads sit calm in brand-subtle; writes (POST/DELETE) warm to amber.
  GET: 'bg-accent-fill text-accent',
  POST: 'bg-warn-fill text-warn',
  DELETE: 'bg-warn-fill text-warn',
};

function MethodChip({ method }: { method: Method }) {
  return (
    <span className={`inline-flex w-[52px] flex-none justify-center rounded-[5px] py-[3px] font-mono text-[10px] font-semibold ${METHOD_CLS[method]}`}>
      {method}
    </span>
  );
}

function ScopeTag({ scope }: { scope: EndpointScope }) {
  return <span className="font-mono text-[11px] text-muted">{scope}</span>;
}

/** Renders `/issues/{owner}/…` with the `{param}` segments dimmed. */
function EndpointPath({ path }: { path: string }) {
  const parts = path.split(/(\{[^}]+\})/g).filter(Boolean);
  return (
    <span className="font-mono text-[12.5px] text-fg">
      {parts.map((p, i) =>
        p.startsWith('{') ? (
          <span key={i} className="text-muted">{p}</span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

/** One endpoint row. The scope shows ONLY when it deviates from the group's
 *  default (jony #343) — so a repeated `board:read` doesn't wall up under a
 *  `board:read` heading, and an exception like `human-only` reads as a signal.
 *  Description sits left-aligned right after the path so they read as one unit. */
function EndpointRow({ e, groupScope }: { e: DocEndpoint; groupScope: EndpointScope }) {
  return (
    <div className="flex items-center gap-3.5 px-4 py-2.5 max-[640px]:flex-wrap max-[640px]:gap-y-1">
      <MethodChip method={e.method} />
      <span className="min-w-[210px] flex-none max-[640px]:min-w-0"><EndpointPath path={e.path} /></span>
      <span className="text-[12.5px] text-muted max-[640px]:ml-[66px]">{e.desc}</span>
      {e.scope !== groupScope && (
        <span className="ml-auto flex-none max-[640px]:ml-[66px]"><ScopeTag scope={e.scope} /></span>
      )}
    </div>
  );
}

/** VARIANT C — the MCP block's own quieter treatment: name, then description,
 *  with the scope stated ONCE, per tool, and dropped from the section header. A
 *  section-level scope becomes a lie the moment a write tool lands, because
 *  READ_SUFFIXES and HUMAN_WRITE_SUFFIXES do not share one. */
function ToolCardC({ tool }: { tool: McpTool }) {
  return (
    <div className={`${BLOCK} px-4 py-3.5`}>
      <div className="flex items-baseline gap-2.5">
        <span className="font-mono text-[12.5px] font-semibold text-fg">{tool.name}</span>
        <span className="ml-auto flex-none"><ScopeTag scope={tool.scope} /></span>
      </div>
      <p className="mt-1 text-[12.5px] leading-[1.55] text-muted">{tool.desc}</p>
    </div>
  );
}

/** A one-line copyable code snippet — the recessed well treatment, mono. */
function CodeLine({ code }: { code: string }) {
  return (
    <div className="relative rounded-[9px] bg-[var(--board-well)] py-2.5 pl-3.5 pr-11">
      <pre className="overflow-x-auto whitespace-pre font-mono text-[12.5px] leading-[1.6] text-dim">{code}</pre>
      <button
        type="button"
        title="Copy"
        onClick={() => copyToClipboard(code, 'Copied')}
        className="absolute right-2 top-2 flex size-7 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-fg"
      >
        <CopyIcon size={13} />
      </button>
    </div>
  );
}

/** A mono fragment inside prose — a parameter, a value, a scope. */
function Tok({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-elevated px-1 py-px font-mono text-[11.5px] text-dim">
      {children}
    </code>
  );
}

/**
 * One step of the OAuth handshake (#456). The number is the point rather than
 * decoration — these six happen in this order and a client that takes them out
 * of order does not get a token — so it carries the same treatment the Account
 * page's connect steps use.
 */
function HandshakeStep({
  n,
  title,
  method,
  path,
  children,
}: {
  n: number;
  title: string;
  method?: Method;
  path?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3 px-4 py-3.5">
      <span className="flex size-[22px] flex-none items-center justify-center rounded-full bg-elevated text-[11px] font-semibold tabular-nums text-dim">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-[12.5px] font-semibold text-fg">{title}</span>
          {method && path && (
            <>
              <MethodChip method={method} />
              <span className="font-mono text-[12px] text-fg">{path}</span>
            </>
          )}
        </div>
        <p className="mt-1.5 text-[12.5px] leading-[1.55] text-dim">{children}</p>
      </div>
    </div>
  );
}

function ScopeCard({ scope, blurb }: { scope: string; blurb: string }) {
  return (
    <div className={`${BLOCK} px-4 py-3.5`}>
      <div className="font-mono text-[12.5px] font-semibold text-fg">{scope}</div>
      <div className="mt-1 text-[12.5px] text-muted">{blurb}</div>
    </div>
  );
}

export function DocsPage() {
  return (
    <div className={ROOT}>
      <div className={COLUMN}>
        {/* Docs is top-level — the big H1 is its identity, no breadcrumb (#391). */}
        <PageHeading className="mb-3">{AREA_LABEL.docs}</PageHeading>
        <p className="mb-2 text-[12.5px] text-muted">
          The board’s read-only mirror, over REST. Point a script or a coding agent at it. All paths are
          under <span className="font-mono text-dim">{API_BASE}</span>.
        </p>

        <Section id="auth">
          <SectionHead label="Auth" />
          <div className={`${BLOCK} px-4 py-3.5`}>
            <p className="text-[12.5px] leading-[1.55] text-dim">
              Every request carries an{' '}
              <code className="rounded bg-elevated px-1 py-px font-mono text-[11.5px] text-dim">Authorization</code>{' '}
              bearer header. Mint a token in Account › Access &amp; agents, then send it with each call.
            </p>
            <div className="mt-3">
              <CodeLine code={`curl -H "Authorization: Bearer board_pat_…" ${API_BASE}/issues/mine`} />
            </div>
          </div>

          {/* The handshake an MCP client runs instead (#456). Written against
              what shipped: six steps, the scopes each accepts, both lifetimes,
              and what a replayed refresh token costs. */}
          <h3 className="mb-2 mt-6 text-[12.5px] font-semibold text-fg">
            The OAuth handshake
          </h3>
          <p className="mb-3 text-[12.5px] leading-[1.55] text-muted">
            A client that speaks MCP authorizes itself rather than carrying a token you pasted into
            it. For that board runs an OAuth 2.1 server, at the root of this host rather than under{' '}
            <Tok>/api</Tok>, and it describes itself at{' '}
            <Tok>/.well-known/oauth-authorization-server</Tok>.
          </p>
          <div className={`${BLOCK} divide-y divide-line`}>
            <HandshakeStep n={1} title="Register" method="POST" path="/register">
              Dynamic client registration: send your redirect URI and a name, and board answers with
              a <Tok>client_id</Tok>. It registers you public and sets{' '}
              <Tok>token_endpoint_auth_method</Tok> to <Tok>none</Tok>, so no client secret is
              issued and none is stored. Because a desktop client cannot keep a secret anyway,
              OAuth 2.1 asks every client for PKCE instead, and board holds you to it from here on.
            </HandshakeStep>
            <HandshakeStep n={2} title="Authorize" method="GET" path="/authorize">
              Then open this in a browser with your <Tok>client_id</Tok>, <Tok>redirect_uri</Tok>,{' '}
              <Tok>state</Tok>, <Tok>code_challenge</Tok> and{' '}
              <Tok>code_challenge_method=S256</Tok>, where the <Tok>scope</Tok> parameter takes one
              of two presets, <Tok>agent</Tok> or <Tok>full</Tok>. If whoever is at the keyboard is
              not signed in, Google comes first and they land back here.
            </HandshakeStep>
            {/* The one step of the six that IS under /api — it is board's own
                screen rather than an endpoint the SDK's router mounts. */}
            <HandshakeStep n={3} title="Consent" method="GET" path="/api/oauth/consent">
              Now board names your client and the address the code will be sent to, and the person
              chooses what to hand over. <Tok>agent</Tok> grants <Tok>board:read</Tok>, while{' '}
              <Tok>full</Tok> grants <Tok>board:read</Tok> and <Tok>board:admin</Tok> and is offered
              only to a board admin. And saying no sends <Tok>access_denied</Tok> back to your
              redirect URI.
            </HandshakeStep>
            <HandshakeStep n={4} title="Exchange the code" method="POST" path="/token">
              <Tok>grant_type=authorization_code</Tok>, with the code, your <Tok>client_id</Tok>,
              the <Tok>redirect_uri</Tok> you asked for, and the <Tok>code_verifier</Tok> behind the
              challenge you sent at step two. In return board answers with an access token good for
              one hour and a refresh token good for thirty days.
            </HandshakeStep>
            <HandshakeStep n={5} title="Refresh" method="POST" path="/token">
              <Tok>grant_type=refresh_token</Tok>. Every refresh rotates the pair, so you get a new
              refresh token back and the one you presented is spent. Present a spent one and board
              reads it as stolen, which kills the whole grant and every token under it. Because
              there is no grace period, that holds however soon you ask again, so if you lose the
              answer to a refresh, go back to step two rather than retrying with the same token.
            </HandshakeStep>
            <HandshakeStep n={6} title="Revoke" method="POST" path="/revoke">
              RFC 7009. Either half of the pair does it: send one with your <Tok>client_id</Tok> and
              the whole grant goes, because revoking the access token alone would leave its holder a
              refresh token and another hour. A token board cannot place is answered with a 200 and
              nothing happens, so the endpoint cannot be used to ask which tokens exist. The person
              can cut you off the same way from Account, under Connected clients.
            </HandshakeStep>
          </div>
        </Section>

        <Section id="scopes">
          <SectionHead label="Scopes" />
          <div className="flex flex-col gap-2.5">
            <ScopeCard scope="board:read" blurb="Read the mirror — issues, projects, metrics, people." />
            <ScopeCard scope="board:admin" blurb="Admin-only writes — identity, agent revoke." />
          </div>
        </Section>

        {DOC_GROUPS.map((g) => (
          <Section key={g.id} id={g.id}>
            <SectionHead label={g.label} scope={g.scope} />
            <div className={`${BLOCK} divide-y divide-line py-1`}>
              {g.endpoints.map((e) => (
                <EndpointRow key={`${e.method} ${e.path}`} e={e} groupScope={g.scope} />
              ))}
            </div>
          </Section>
        ))}

        <Section id="mcp">
          <SectionHead label="MCP" />
          <div className={`${BLOCK} px-4 py-3.5`}>
            <div className="flex items-center gap-3.5">
              <MethodChip method="POST" />
              <span className="font-mono text-[12.5px] text-fg">/mcp</span>
            </div>
            {/* The endpoint's own scope is stated HERE, not on the section header:
                each tool carries its own, and a header scope stops being true the
                moment a write tool lands (#536). */}
            <p className="mt-2.5 text-[12.5px] leading-[1.55] text-muted">
              MCP over HTTP. Reaching the endpoint takes{' '}
              <span className="font-mono text-dim">board:read</span>; each tool below
              states its own scope. A client that finishes the OAuth handshake gets those tools.
            </p>
          </div>
          <div className="mt-2.5 flex flex-col gap-2.5">
            {MCP_TOOLS.map((t) => (
              <ToolCardC key={t.name} tool={t} />
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
