import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { GithubProjectsSource, StatusResolutionError } from './github-projects.source';

const createdAt = '2026-07-01T00:00:00Z';
const later = '2026-07-02T00:00:00Z';
const field = (id: string, name: string, timestamp: string | null = createdAt) => ({
  __typename: 'ProjectV2SingleSelectField', id, name, createdAt: timestamp,
});
const value = (id: string, name: string, fieldName = 'Workflow') => ({
  __typename: 'ProjectV2ItemFieldSingleSelectValue', name, field: { id, name: fieldName },
});
const item = (number: number, values = [value('seeded', 'In Progress')]) => ({
  fieldValues: { nodes: values },
  content: {
    __typename: 'Issue', number, title: `Issue ${number}`, url: `issue/${number}`,
    state: 'OPEN', stateReason: null, body: '', createdAt, updatedAt: createdAt,
    labels: { totalCount: 0, nodes: [] },
  },
});

function fixture(fields = [field('seeded', 'Workflow')], pages = 1, values = [value('seeded', 'In Progress')]) {
  const connection = <T>(query: string, name: string, nodes: T[]) => {
    const limit = Number(query.match(new RegExp(name + String.raw`\(first:\s*(\d+)`))?.[1]);
    return { nodes: nodes.slice(0, limit), pageInfo: { hasNextPage: nodes.length > limit } };
  };
  const graphql = vi.fn(async (query: string, vars: { after?: string }) => ({
    organization: {
      projectV2: {
        ...(!vars.after ? {
          number: 4, title: 'Board', url: 'project/4', closed: false, createdAt,
          fields: connection(query, 'fields', fields),
        } : {}),
        items: {
          totalCount: pages,
          nodes: [{ ...item(vars.after ? 2 : 1, values), fieldValues: connection(query, 'fieldValues', values) }],
          pageInfo: { hasNextPage: pages > 1 && !vars.after, endCursor: vars.after ? null : 'next' },
        },
      },
    },
  }));
  const source = new GithubProjectsSource({ get: (_key: string, fallback: unknown) => fallback } as unknown as ConfigService);
  // @ts-expect-error Inject the external GraphQL transport.
  source.graphql = graphql;
  return { source, graphql };
}

describe('Queue status field identity (#1218)', () => {
  it.each([1, 2])('uses %i GraphQL requests for that many item pages', async (pages) => {
    const { source, graphql } = fixture(undefined, pages);
    const result = await source.getProject('team', 4);
    expect(result?.items).toHaveLength(pages);
    expect(graphql).toHaveBeenCalledTimes(pages);
  });

  it.each([1, 2])('keeps renamed Status values across %i item pages without a schema round trip', async (pages) => {
    const { source, graphql } = fixture(undefined, pages);
    const result = await source.getProject('team', 4);
    expect(result?.items.map((i) => i.status)).toEqual(Array(pages).fill('In Progress'));
    expect(graphql).toHaveBeenCalledTimes(pages);
    const firstQuery = graphql.mock.calls[0][0];
    expect(firstQuery).toMatch(/projectV2\(number:\$number\)\s*\{[^{}]*\bcreatedAt\b/);

    expect(firstQuery).toMatch(/ProjectV2FieldCommon\s*\{[^}]*\bid\b[^}]*\bcreatedAt\b/);
    for (const [query] of graphql.mock.calls) {
      expect(query).not.toContain('fieldValueByName');
      expect(query).toMatch(/ProjectV2ItemFieldSingleSelectValue\s*\{[^}]*field\s*\{\s*\.\.\. on ProjectV2FieldCommon\s*\{\s*id\b/);
    }
  });

  const extras = (count: number) => Array.from({ length: count }, (_, i) => field('custom-' + i, 'Custom ' + i, later));
  const extraValues = (count: number) => Array.from({ length: count }, (_, i) => value('custom-' + i, 'Other'));

  it.each([1, 2])('reads Status definition at entry 31 across %i item pages', async (pages) => {
    const { source, graphql } = fixture([...extras(30), field('seeded', 'Workflow')], pages);
    expect((await source.getProject('team', 4))?.items.map((i) => i.status)).toEqual(Array(pages).fill('In Progress'));
    expect(graphql).toHaveBeenCalledTimes(pages);
  });

  it.each([1, 2])('reads Status value at entry 31 across %i item pages', async (pages) => {
    const { source, graphql } = fixture([field('seeded', 'Workflow'), ...extras(30)], pages, [...extraValues(30), value('seeded', 'In Progress')]);
    expect((await source.getProject('team', 4))?.items.map((i) => i.status)).toEqual(Array(pages).fill('In Progress'));
    expect(graphql).toHaveBeenCalledTimes(pages);
  });

  it('reads Status inside the old window with 31 definitions', async () => {
    const { source } = fixture([field('seeded', 'Workflow'), ...extras(30)]);
    expect((await source.getProject('team', 4))?.items[0].status).toBe('In Progress');
  });

  it.each([40, 50, 100])('reads the last definition and value of %i entries in one request', async (count) => {
    const { source, graphql } = fixture([...extras(count - 1), field('seeded', 'Workflow')], 1, [...extraValues(count - 1), value('seeded', 'In Progress')]);
    expect((await source.getProject('team', 4))?.items[0].status).toBe('In Progress');
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('rejects truncated definitions even when Status is visible', async () => {
    const { source } = fixture([field('seeded', 'Workflow'), ...extras(100)]);
    await expect(source.getProject('team', 4)).rejects.toBeInstanceOf(StatusResolutionError);
  });

  it.each([1, 2])('rejects truncated values across %i item pages', async (pages) => {
    const { source } = fixture(undefined, pages, [...extraValues(100), value('seeded', 'In Progress')]);
    await expect(source.getProject('team', 4)).rejects.toBeInstanceOf(StatusResolutionError);
  });

  it('rejects an incomplete value connection only on the continuation page', async () => {
    const { source, graphql } = fixture(undefined, 2);
    const answer = graphql.getMockImplementation()!;
    graphql.mockImplementation(async (query, vars) => {
      const response = await answer(query, vars);
      if (vars.after) response.organization.projectV2.items.nodes[0].fieldValues.pageInfo.hasNextPage = true;
      return response;
    });
    await expect(source.getProject('team', 4)).rejects.toBeInstanceOf(StatusResolutionError);
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it.each(['fields', 'fieldValues'])('rejects missing completeness metadata for %s', async (connection) => {
    const { source, graphql } = fixture();
    const answer = graphql.getMockImplementation()!;
    graphql.mockImplementation(async (query, vars) => {
      const response = await answer(query, vars);
      const project = response.organization.projectV2;
      const target = connection === 'fields' ? project.fields! : project.items.nodes[0].fieldValues;
      Reflect.deleteProperty(target, 'pageInfo');
      return response;
    });
    await expect(source.getProject('team', 4)).rejects.toBeInstanceOf(StatusResolutionError);
  });

  it('ignores a later custom field named Status and matches the renamed field by ID', async () => {
    const { source } = fixture(
      [field('custom', 'Status', later), field('seeded', 'Workflow')], 1,
      [value('custom', 'Blocked', 'Status'), value('seeded', 'In Progress')],
    );
    expect((await source.getProject('team', 4))?.items[0].status).toBe('In Progress');
  });

  it.each([
    ['no candidate', [field('custom', 'Status', later)]],
    ['ambiguous candidates', [field('seeded', 'Workflow'), field('other', 'Status')]],
    ['missing timestamp', [field('seeded', 'Workflow', null)]],
    ['invalid timestamp', [field('seeded', 'Workflow', 'invalid')]],
  ])('rejects unresolved status with %s', async (_name, fields) => {
    const { source } = fixture(fields);
    await expect(source.getProject('team', 4)).rejects.toBeInstanceOf(StatusResolutionError);
  });

  it('leaves status empty when the identified field has no value', async () => {
    const { source } = fixture(undefined, 1, [value('custom', 'Blocked', 'Status')]);
    expect((await source.getProject('team', 4))?.items[0].status).toBe('');
  });

  it('exposes the shared heuristic limitation when a lone custom field has the project timestamp', async () => {
    const { source } = fixture([field('custom', 'Priority')], 1, [value('custom', 'High', 'Priority')]);
    expect((await source.getProject('team', 4))?.items[0].status).toBe('High');
  });
});
