import {test} from 'node:test';import assert from 'node:assert/strict';
import {calculateDraft,bestLineup,nextOwnPick,ownPick,normalizeDraftSettings} from '../docs/draft-calculator.mjs';
const p=(id,pos,points,adp=null)=>({player_id:id,player:id,pos,team:'BUF',projected_points:points,adp});
const slots={QB:1,RB:1,WR:0,TE:0,FLEX:0,SF:0,K:0,DST:0};
test('snake and straight turns handle both ends and back-to-back picks',()=>{
 assert.deepEqual([1,2,3,4].map(r=>ownPick(r,12,1)),[1,24,25,48]);
 assert.deepEqual([1,2,3].map(r=>ownPick(r,12,12)),[12,13,36]);
 assert.deepEqual(nextOwnPick(14,normalizeDraftSettings({teams:12,slot:12})),{pick:36,round:3});
 assert.equal(ownPick(3,12,7,'linear'),31);
});
test('flex and superflex never double-count a player and bench stays separate',()=>{
 const roster=[p('q1','QB',300),p('q2','QB',270),p('r1','RB',250),p('w1','WR',200),p('t1','TE',180)];
 const result=bestLineup(roster,{QB:1,RB:1,WR:0,TE:0,FLEX:1,SF:1});
 assert.equal(result.points,1020);assert.equal(new Set(result.assignments.map(s=>s.player.player_id)).size,4);assert.equal(result.bench[0].player_id,'t1');
});
test('positional scarcity and the next turn can favor RB over higher raw QB points',()=>{
 const players=[...Array.from({length:8},(_,i)=>p(`q${i}`,'QB',300-i*5,100+i)),...Array.from({length:12},(_,i)=>p(`r${i}`,'RB',250-i*25,1+i))];
 const result=calculateDraft(players,[],[],{teams:4,slot:1,slots,bench:0});
 assert.equal(result.recommendations[0].player.player_id,'r0');assert.equal(result.recommendations[0].next_player.pos,'QB');
 assert.equal(result.your_pick,1);assert.equal(result.next_pick,8);assert.equal(result.between_picks,6);
});
test('taken and owned players are unavailable; unknown projections never become fake recommendations',()=>{
 const players=[p('q1','QB',300,1),p('q2','QB',290,2),p('r1','RB',260,3),p('r2','RB',250,4),p('unknown','RB',null)];
 const result=calculateDraft(players,['q1'],['r1'],{teams:4,slots,bench:1,currentPick:1});
 assert.ok(result.recommendations.every(r=>!['q1','r1','unknown'].includes(r.player.player_id)));assert.equal(result.unrated,1);
 assert.equal(result.recommendations[0].player.player_id,'r2');
 assert.equal(calculateDraft(players,['q1','r1'],[],{teams:4,slots,bench:0}).recommendations.length,0);
});
test('scoring uses fantasy points rather than the display index and unknown ADP stays unknown',()=>{
 const players=[p('q1','QB',300),p('q2','QB',280),p('r1','RB',250),p('r2','RB',200)];
 const settings={teams:4,slots,bench:1,opponents:'projection'};
 const a=calculateDraft(players,[],[],settings),b=calculateDraft(players.map((p,i)=>({...p,ros_index:10000-i*5000,draft_index:i*9999})),[],[],settings);
 assert.deepEqual(a.recommendations.map(r=>[r.player.player_id,r.score]),b.recommendations.map(r=>[r.player.player_id,r.score]));assert.equal(a.missing_adp,4);
});
