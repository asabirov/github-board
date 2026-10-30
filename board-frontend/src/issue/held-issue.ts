import type { IssueDetail } from '../api/issues';
import { copyResponseDeadline } from '../auth/response-deadline';

/** A partial write cannot extend the issue or the response it was derived from. */
export function patchIssueResponse(issue: IssueDetail, patch: Partial<IssueDetail>): IssueDetail {
  return copyResponseDeadline(patch, copyResponseDeadline(issue, { ...issue, ...patch }));
}
