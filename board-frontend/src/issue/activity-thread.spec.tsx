import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { IssueActivityEvent, IssueComment } from '../api/issues';
import { activityOrder, ActivityEvent, ActivityNotice } from './activity-thread';
const event = (id: string, at: string, kind: IssueActivityEvent['kind'] = 'closed'): IssueActivityEvent => ({id, createdAt: at, kind, actor:null});
const comment = (n:number, at:string): IssueComment => ({author:null,createdAt:at,bodyMarkdown:`Comment ${n}`,htmlUrl:`https://github.com/o/r/issues/1#issuecomment-${n}`});
const at = (n:number) => `2026-09-06T${String(n).padStart(2,'0')}:00:00Z`;
const keys = (rows:ReturnType<typeof activityOrder>) => rows.map(r=>r.kind === 'gap' ? 'gap' : r.kind === 'event' ? r.event.id : r.comment.bodyMarkdown);

describe('chronological activity and comments',()=>{
  it('interleaves mixed events and comments rather than grouping by kind',()=>{
    expect(keys(activityOrder([comment(1,at(2)),comment(2,at(4))],[event('later',at(5)),event('first',at(1)),event('middle',at(3))],false,0))).toEqual(['first','Comment 1','middle','Comment 2','later']);
  });
  it('preserves upstream event order on ties and deduplicates event identities only',()=>{
    expect(keys(activityOrder([comment(1,at(1)),comment(2,at(1))],[event('b',at(1)),event('a',at(1)),event('b',at(1))],false,0))).toEqual(['b','a','Comment 1','Comment 2']);
  });
  it('keeps newer events and newly posted comments beyond the unread comment gap',()=>{
    expect(keys(activityOrder([comment(1,at(2)),comment(2,at(6))],[event('old',at(1)),event('middle',at(4)),event('new',at(7))],true,1))).toEqual(['old','Comment 1','gap','middle','Comment 2','new']);
  });
  it('does not invent a time for malformed events or duplicate React keys for comments without links',()=>{
    const c={...comment(1,at(1)),htmlUrl:null};
    const rows=activityOrder([c,c],[event('bad','invalid')],false,0);
    expect(keys(rows)).toEqual(['Comment 1','Comment 1']);
    expect(new Set(rows.map(r=>r.key)).size).toBe(2);
  });
});

describe('activity rendering',()=>{
  it('renders missing actors and missing data as prose, never undefined or unsafe HTML',()=>{
    for(const kind of ['labeled','unlabeled','assigned','unassigned','milestoned','demilestoned','closed','reopened','cross-referenced','referenced'] as const){
      const html=renderToStaticMarkup(<ActivityEvent event={event('1',at(1),kind)} name={p=>p?.login ?? 'Someone'} />);
      expect(html).toContain('Someone');
      expect(html).not.toMatch(/undefined|Invalid Date/);
    }
    const html=renderToStaticMarkup(<ActivityEvent event={{...event('1',at(1),'labeled'),label:'<script>alert(1)</script>'}} name={()=>'Someone'}/>);
    expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');
  });
  it('rejects unsafe links even in an old or corrupt cached payload',()=>{
    for(const url of ['javascript:alert(1)','https://github.com.evil/o/r/issues/1','https://x@github.com/o/r/issues/1','https://github.com/o/r/issues/1?x=1']){
      const html=renderToStaticMarkup(<ActivityEvent event={{...event('1',at(1),'cross-referenced'),reference:{url,label:'#1'}}} name={()=>'Someone'}/>);
      expect(html).not.toContain('href=');
    }
  });
  it('renders reference numbers and preserves accessible actor links',()=>{
    const html=renderToStaticMarkup(<ActivityEvent event={{...event('1',at(1),'cross-referenced'),actor:{login:'octocat',name:null},reference:{url:'https://github.com/o/r/issues/42',label:'#42'}}} name={p=>p?.login ?? 'Someone'} />);
    expect(html).toContain('https://github.com/octocat');expect(html).toContain('https://github.com/o/r/issues/42');expect(html).toContain('mentioned this');
  });
  it('says when activity could not be read or was cut short, including old payloads',()=>{
    for(const state of [undefined,'unreadable','partial'] as const){
      const html=renderToStaticMarkup(<ActivityNotice activity={state ? {state,events:[]} : undefined} url="https://github.com/o/r/issues/1"/>);
      expect(html).toContain('GitHub');expect(html).not.toContain('No activity');
    }
    expect(renderToStaticMarkup(<ActivityNotice activity={{state:'read',events:[]}} url="https://github.com/o/r/issues/1"/>)).toBe('');
  });
});
