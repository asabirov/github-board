import type { ConfigService } from '@nestjs/config';

/**
 * The two builders every capability spec makes its inputs with (#584).
 *
 * They live in one file rather than being re-declared per spec: two error
 * builders that drifted apart would make the contract table and the classifier
 * spec test different inputs while reading as if they tested the same one.
 *
 * `*.contract.ts` is excluded from the build (`tsconfig.build.json:12`), so this
 * compiles under the typecheck CI runs and never reaches `dist`.
 */

/** An Octokit RequestError as it really arrives: status on the error, headers
 *  hung off `response`. `github-repos.source.ts` reads both shapes. */
export const gh = (status: number, headers: Record<string, string> = {}, message = 'Not Found') =>
  Object.assign(new Error(message), { status, response: { headers, data: { message } } });

/**
 * A ConfigService stub. No argument answers every key with its default, except
 * the two that name the org the sample data in these specs is written against:
 * `GITHUB_ORGS` and `FEEDBACK_REPO`.
 *
 * The pins are #1166. `acme` was both keys' default as well as the sample
 * org, so a spec that set neither got a matching scope by accident — and the
 * feedback write pin compares the two against each other, so they have to move
 * together or not at all. The organisation was renamed to `acme` and the
 * accident stopped holding, and #1175 then took both defaults off altogether, so
 * an unnamed key is a refusal rather than some other org. A spec that means one
 * org says which, and the samples stay where they are. Pass either key to
 * override it — the empty-list cases in `capability.registry.spec.ts` and the
 * second-org case in `github-feedback.source.spec.ts` do.
 */
export const cfg = (env: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = {
    GITHUB_ORGS: 'acme',
    FEEDBACK_REPO: 'acme/board',
    FEEDBACK_REPO_ID: 42,
    ...env,
  };
  return { get: (k: string, d?: unknown) => values[k] ?? d } as unknown as ConfigService;
};
