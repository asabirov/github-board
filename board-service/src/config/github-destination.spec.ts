import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { configuredRepository } from './github-destination';
const config = (id?: number) => new ConfigService({ FEEDBACK_REPO: 'old/widgets', FEEDBACK_REPO_ID: id });
const client = (id = 42, full_name = 'new/renamed') => ({ request: vi.fn().mockResolvedValue({ data: { id, full_name } }) });
describe('configured GitHub destination identity', () => {
  it('follows repository rename and transfer using the configured id', async () => {
    expect(await configuredRepository(config(42), 'FEEDBACK_REPO', client())).toEqual({ owner: 'new', repo: 'renamed', id: 42 });
  });
  it('does not bind an old name on first use', async () => {
    const github = client(99, 'old/widgets');
    await expect(configuredRepository(config(), 'FEEDBACK_REPO', github)).rejects.toThrow(/being set up/);
    expect(github.request).not.toHaveBeenCalled();
  });
  it('refuses a replacement repository', async () => {
    await expect(configuredRepository(config(42), 'FEEDBACK_REPO', client(99))).rejects.toThrow(/identity/);
  });
  it('propagates deletion without retrying by name', async () => {
    const github = { request: vi.fn().mockRejectedValue({ status: 404 }) };
    await expect(configuredRepository(config(42), 'FEEDBACK_REPO', github)).rejects.toMatchObject({ status: 404 });
    expect(github.request).toHaveBeenCalledTimes(1);
  });
});
