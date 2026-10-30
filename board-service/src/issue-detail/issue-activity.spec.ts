import {describe, expect, it, vi} from 'vitest';
import {readActivity, shapeActivityEvent} from './issue-activity';
const here = {owner: 'acme', repo: 'board', number: 882};
const event = (over: Record<string, unknown> = {}) => ({id: 1, event: 'labeled', created_at: '2026-09-06T10:00:00Z', actor: {login: 'octocat'}, label: {name: 'bug', color: 'd73a4a'}, ...over});

describe('issue activity normalization', () => {
  it('keeps event identity, time, label and actor without upstream extras', () => {
    expect(shapeActivityEvent(event({body: 'SECRET'}), here)).toEqual({id: '1', kind: 'labeled', createdAt: '2026-09-06T10:00:00Z', actor: {login:'octocat',name:null}, label: 'bug'});
  });
  it('retains all requested lifecycle types and tolerates absent people and values', () => {
    for (const kind of ['labeled','unlabeled','assigned','unassigned','milestoned','demilestoned','closed','reopened','cross-referenced','referenced']) {
      expect(shapeActivityEvent(event({event:kind, actor:null, label:null}),here)).toMatchObject({kind, actor:null});
    }
    expect(shapeActivityEvent(event({event:'assigned', assignee:{login:'new-owner'}, assigner:{login:'assigner'},actor:null}),here)).toMatchObject({assignee:'new-owner',actor:{login:'assigner'}});
    expect(shapeActivityEvent(event({event:'milestoned', milestone:{title:'Launch'}}),here)).toMatchObject({milestone:'Launch'});
  });
  it('skips comments, unknown events and malformed time/identity without inventing chronology', () => {
    for (const over of [{event:'commented'},{event:'future-kind'},{created_at:null},{created_at:'bad'},{id:null}, {actor:{login:'bad/login'},event:'commented'}]) expect(shapeActivityEvent(event(over),here)).toBeNull();
  });
  it('never exposes reference titles, bodies or private cross-repo identities', () => {
    const source = {issue:{html_url:'https://github.com/secret/repo/issues/42',title:'PRIVATE_TITLE',body:'PRIVATE_BODY',repository:{private:true}}};
    const result=shapeActivityEvent(event({event:'cross-referenced',source}),here);
    expect(result).toMatchObject({kind:'cross-referenced',reference:null});
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|secret/);
  });
  it('keeps real cross-reference events that have no event ID without exposing their source identity', () => {
    const raw=event({id:undefined,event:'cross-referenced',source:{issue:{id:987,title:'SECRET',html_url:'https://github.com/secret/repo/issues/42'}}});
    const result=shapeActivityEvent(raw,here);
    expect(result?.id).toMatch(/^reference-[a-f0-9]{64}$/);
    expect(shapeActivityEvent(raw,here)?.id).toBe(result?.id);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|987|secret\/repo/);
  });
  it('links same-repo and explicitly public references by number only', () => {
    for(const [url,repository] of [['https://github.com/acme/board/issues/42',{}],['https://github.com/public/repo/pull/42',{private:false}]] as const){
      const result=shapeActivityEvent(event({event:'cross-referenced',source:{issue:{html_url:url,repository,title:'SECRET'}}}),here);
      expect(result?.reference?.url).toBe(url);
      expect(JSON.stringify(result)).not.toContain('SECRET');
    }
  });
  it('links a private cross-repo mention once the timeline is read under the viewer\u2019s own credential (#1331)', () => {
    const source={issue:{html_url:'https://github.com/acme/acme-ui/issues/1081',title:'PRIVATE_TITLE',body:'PRIVATE_BODY',repository:{private:true}}};
    const result=shapeActivityEvent(event({event:'cross-referenced',source}),{...here,viewerCredential:true});
    expect(result?.reference).toEqual({url:'https://github.com/acme/acme-ui/issues/1081',label:'acme/acme-ui#1081'});
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TITLE|PRIVATE_BODY/);
  });
  it('links a cross-repo commit under the viewer credential without its title or message (#1331)', () => {
    const raw=event({event:'referenced',commit_url:`https://api.github.com/repos/acme/acme-ui/commits/${'a'.repeat(40)}`,title:'PRIVATE_TITLE',message:'PRIVATE_MESSAGE'});
    const result=shapeActivityEvent(raw,{...here,viewerCredential:true});
    expect(result?.reference).toEqual({url:`https://github.com/acme/acme-ui/commit/${'a'.repeat(40)}`,label:'aaaaaaa'});
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TITLE|PRIVATE_MESSAGE/);
  });
  it('withholds a cross-repo commit under a deployment credential (#1331)', () => {
    const raw=event({event:'referenced',commit_url:`https://api.github.com/repos/acme/acme-ui/commits/${'a'.repeat(40)}`});
    for(const context of [here,{...here,viewerCredential:false}]) {
      expect(shapeActivityEvent(raw,context)?.reference).toBeNull();
    }
  });
  it('rejects unsafe or ambiguous reference URLs and malformed actor logins', () => {
    for(const url of ['javascript:alert(1)','https://github.com.evil/x/y/issues/1','https://user@github.com/x/y/issues/1','https://github.com/x/y/issues/1?secret=x','https://github.com/x/y/issues/1#x','https://github.com/x/y/issues/0']) {
      expect(shapeActivityEvent(event({event:'cross-referenced',source:{issue:{html_url:url,repository:{private:false}}}}),here)?.reference).toBeNull();
    }
    expect(shapeActivityEvent(event({actor:{login:'x/../../evil'}}),here)?.actor).toBeNull();
  });
});

describe('paginated activity reads', () => {
  it('reads every next page, deduplicates IDs and sorts chronologically with stable ties', async () => {
    const read=vi.fn().mockResolvedValueOnce({data:[event({id:2,created_at:'2026-09-06T11:00:00Z'})],headers:{link:'<https://api.github.com/next>; rel="next"'}}).mockResolvedValueOnce({data:[event({id:1}),event({id:2,created_at:'2026-09-06T11:00:00Z'}),event({id:3})],headers:{}});
    expect(await readActivity(read,here)).toMatchObject({state:'read',events:[{id:'1'},{id:'3'},{id:'2'}]});
    expect(read.mock.calls.map(([args])=>args)).toEqual([{owner:here.owner,repo:here.repo,issue_number:882,per_page:100,page:1},{owner:here.owner,repo:here.repo,issue_number:882,per_page:100,page:2}]);
  });
  it('distinguishes failed and partial reads from a genuinely empty read', async () => {
    expect(await readActivity(vi.fn().mockRejectedValue(new Error('secret upstream detail')),here)).toEqual({state:'unreadable',events:[]});
    expect(await readActivity(vi.fn().mockResolvedValue({data:[],headers:{}}),here)).toEqual({state:'read',events:[]});
    const read=vi.fn().mockResolvedValueOnce({data:[event()],headers:{link:'<next>; rel="next"'}}).mockRejectedValue(new Error('outage'));
    expect(await readActivity(read,here)).toMatchObject({state:'partial',events:[{id:'1'}]});
  });
  it('bounds an endless upstream and reports partial rather than silently complete', async () => {
    const read=vi.fn().mockResolvedValue({data:[event()],headers:{link:'<next>; rel="next"'}});
    expect((await readActivity(read,here)).state).toBe('partial');
    expect(read).toHaveBeenCalledTimes(10);
  });
  it('flags malformed pages and known events missing chronology as incomplete', async () => {
    expect((await readActivity(vi.fn().mockResolvedValue({data:null,headers:{}}),here)).state).toBe('unreadable');
    expect((await readActivity(vi.fn().mockResolvedValue({data:[event({created_at:null})],headers:{}}),here)).state).toBe('partial');
  });
});
