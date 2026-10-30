// The synthetic Github's shape, shared by fake-github.mjs and the scripts that
// talk about the same repos from outside the service (send-webhook.mjs and
// v5-latency.mjs), so a delivery names a repo by the id the listing gave it.
//
// FAKE_ORGS="acme:96:8,globex:29:4" is org:repos:members, in order.

export function orgsFrom(spec = process.env.FAKE_ORGS ?? 'acme:96:8') {
  return new Map(
    spec.split(',').map((s, index) => {
      const [org, repos, members] = s.split(':');
      return [org.toLowerCase(), { org, index, repos: Number(repos), members: Number(members) }];
    }),
  );
}

/** Github's id for synthetic repo `org/repo-<i>`. Unique across orgs, as a
 *  real repository id is, because the webhook store keys on it. */
export function repoId(orgs, org, i) {
  const o = orgs.get(org.toLowerCase());
  return (o ? o.index + 1 : 99) * 100_000 + i + 1;
}

/** The repository `repoId` gave that id, or undefined. Github answers
 *  `GET /repositories/{id}` this way, and board reads it to verify a
 *  destination it follows by id (#1374). */
export function repoAtId(orgs, id) {
  const index = Math.floor(Number(id) / 100_000) - 1;
  const i = (Number(id) % 100_000) - 1;
  const owner = [...orgs.values()].find((o) => o.index === index);
  return owner && i >= 0 && i < owner.repos ? { org: owner.org, name: `repo-${i}`, index: i } : undefined;
}

/** The installation of the board's App on `org`: one per org, as on Github. */
export function installationId(orgs, org) {
  const o = orgs.get(org.toLowerCase());
  return (o ? o.index : 98) + 1;
}

/**
 * The synthetic owners one signed-in person's Github App grants cover, named by
 * FAKE_GRANTS as "acme,globex", in that order. Unset, a person holds no
 * installation, which is the shape every earlier count was taken in.
 *
 * It is read on every request, so one process can measure a narrow grant and a
 * broad one. An owner FAKE_ORGS does not describe is dropped rather than
 * invented: the person's repository list has to name repositories the synthetic
 * Github also serves, or an ingest count stops meaning anything.
 */
export function grantsFrom(orgs, spec = process.env.FAKE_GRANTS ?? '') {
  return spec.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)
    .map((login) => orgs.get(login)).filter(Boolean);
}
