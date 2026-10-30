import { describe, expect, it } from 'vitest';
import { surfaceParts } from './surface';

describe('surfaceParts (#313)', () => {
  it('strips the shell prefix and title-cases the first two segments', () => {
    expect(surfaceParts('/acme/~/mail/broadcasts')).toEqual(['Mail', 'Broadcasts']);
    expect(surfaceParts('/acme/~/consent/customization')).toEqual(['Consent', 'Customization']);
  });

  it('drops a trailing uuid instance id', () => {
    expect(
      surfaceParts('/acme/~/deployment/environments/69134080-43fc-4db3-8297-e5720f88c2e8'),
    ).toEqual(['Deployment', 'Environments']);
  });

  it('keeps a non-id third segment out by taking only the first two areas', () => {
    expect(surfaceParts('/acme/~/realtime/namespaces/prod')).toEqual(['Realtime', 'Namespaces']);
  });

  it('title-cases hyphenated segments', () => {
    expect(surfaceParts('/acme/~/google-ads/roas')).toEqual(['Google Ads', 'Roas']);
  });

  it('handles a single area segment', () => {
    expect(surfaceParts('/acme/~/settings')).toEqual(['Settings']);
  });

  it('returns no parts for empty / unparseable input', () => {
    expect(surfaceParts(null)).toEqual([]);
    expect(surfaceParts('')).toEqual([]);
    expect(surfaceParts('/acme/~/')).toEqual([]);
  });

  // The parts come out unjoined so the row can space and tone them (#448). A
  // separator baked in here would just be the chain again, one layer down.
  it('returns each area on its own, with no separator glyph baked in', () => {
    expect(surfaceParts('/acme/~/mail/broadcasts')).toHaveLength(2);
    for (const part of surfaceParts('/acme/~/mail/broadcasts')) {
      expect(part).not.toMatch(/[·|–—/]/);
    }
  });
});
