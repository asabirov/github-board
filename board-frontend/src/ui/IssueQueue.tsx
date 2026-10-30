import type { ComponentProps } from 'react';
import { IssuesViewer } from '../issues-viewer/IssuesViewer';

type Props = Pick<ComponentProps<typeof IssuesViewer>,
  'heading' | 'issues' | 'options' | 'now' | 'timeZone' | 'persistKey' | 'emptyText'>;

/** My work and Overview share queue presentation; each page supplies its data and saved-view key. */
export function IssueQueue(props: Props) {
  return <IssuesViewer {...props} showTriage hideRowLabels defaultGroup={['project', 'type']} defaultView="board" />;
}
