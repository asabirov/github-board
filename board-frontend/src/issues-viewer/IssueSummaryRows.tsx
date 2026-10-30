import { boardLinkProps } from '../repos/repo-page-parts';
import { issuePathFromUrl } from '../route';
import { IssueActions } from '../ui/IssueActions';
import { AssigneeCluster } from '../ui/AssigneeCluster';
import type { ViewerIssue } from './viewer-issue';

export function IssueSummaryRows({ issues, mayClose }: { issues: ViewerIssue[]; mayClose: boolean }) {
  return <div className="flex flex-col gap-2">{issues.map(item => {
      const path = issuePathFromUrl(item.htmlUrl);
      return <IssueActions key={item.htmlUrl} issue={item} closed={item.state === 'closed'} mayClose={mayClose} mayAssign={false} appearance="solid" className="grid grid-cols-[minmax(0,1fr)_auto_44px] items-center gap-3">
        <a {...boardLinkProps(path)} aria-label={[item.title, `${item.repo} #${item.number}`, item.state, ...item.labels.map(label => label.name)].join(', ')} className="flex min-h-11 min-w-0 break-words flex-col justify-center rounded-lg text-[13px] hover:underline focus-visible:outline-3 focus-visible:outline-offset-2">
          <span className={item.state === 'closed' ? 'text-dim' : 'text-fg'}>{item.title}</span>
          <span className="text-[11px] text-muted">{item.repo} #{item.number}{item.state === 'closed' ? ', closed' : ''}</span>
        </a>
        <AssigneeCluster logins={item.assignees} />
      </IssueActions>;
    })}</div>;
}
