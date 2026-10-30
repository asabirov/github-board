export type StoreHealthState = 'off' | 'unread' | 'serving' | 'unavailable';

/** Public health carries store availability without per-person ingest facts. */
export class IssueStoreHealth {
  private state: StoreHealthState | null = null;

  record(state: StoreHealthState): void {
    this.state = state;
  }

  snapshot(enabled: boolean) {
    return { state: this.state ?? (enabled ? 'unread' : 'off') };
  }
}
