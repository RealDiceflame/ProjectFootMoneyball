import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareTrade,tradeSlots} from '../docs/trade-calculator.mjs';
const player=(id,pos,points,surplus=points-20,weeks=[points])=>({player_id:id,player:id,pos,ros_points:points,ros_surplus:surplus,draft_points:points*2,draft_surplus:surplus*2,dynasty_points:points*3,dynasty_surplus:surplus*3,forecast_games:weeks.map((points,i)=>({week:12+i,points}))});
const slots={QB:0,RB:1,WR:0,TE:0,FLEX:0,SF:0};
test('trade packages use signed projection surplus, never summed display indices',()=>{
 const rows=[player('a','RB',100,30),player('b','WR',90,50),player('c','WR',20,-10)];
 const input={give:['a'],receive:['b','c']},result=compareTrade({rows},input);assert.equal(result.edge,10);assert.equal(result.extra_roster_spots,1);
 const changed=rows.map((p,i)=>({...p,ros_index:i*10000}));assert.equal(compareTrade({rows:changed},input).edge,result.edge);
 assert.equal(compareTrade({rows},{give:['b','c'],receive:['a']}).edge,-10);
 assert.equal(compareTrade({rows},{...input,horizon:'dynasty'}).edge,30);
});
test('duplicate IDs do not add value and cross-side duplicates are invalid',()=>{
 const board={rows:[player('a','RB',100),player('b','RB',120)]};assert.equal(compareTrade(board,{give:['a','a'],receive:['b']}).give.count,1);
 assert.equal(compareTrade(board,{give:['a'],receive:['a']}).edge,null);
 assert.equal(compareTrade(board,{give:[],receive:['b']}).edge,null);
});
test('unknown, missing, and oversized packages never produce an advantage',()=>{
 const unknown={...player('unknown','WR',100),ros_points:null,ros_surplus:null};const rows=[player('a','RB',100),unknown,...Array.from({length:9},(_,i)=>player(`r${i}`,'RB',30))];
 for(const receive of [['unknown'],['missing'],Array.from({length:9},(_,i)=>`r${i}`)])assert.equal(compareTrade({rows},{give:['a'],receive}).edge,null);
});
test('two-for-one starters do not add bench production and require explicit capacity',()=>{
 const board={rows:[player('star','RB',100),player('part1','RB',60),player('part2','RB',60)]};const input={give:['star'],receive:['part1','part2'],rosterComplete:true,slots,bench:0};
 const full=compareTrade(board,input);assert.equal(full.roster.gain,null);assert.match(full.roster.issues.join(' '),/1 more drop/);
 const fit=compareTrade(board,{...input,bench:1});assert.equal(fit.roster.gain,-40);assert.equal(fit.roster.after_points,60);
 const drop=compareTrade(board,{...input,drops:['part2']});assert.equal(drop.roster.gain,-40);assert.equal(drop.roster.after.length,1);
});
test('weekly ROS allocation handles byes and flex/superflex without double counting',()=>{
 const rows=[player('a','QB',40,10,[40,0]),player('b','QB',40,10,[20,20]),player('c','QB',40,10,[0,40]),player('r','RB',30,10,[15,15])];
 const input={give:['a'],receive:['b'],retained:['c','r'],rosterComplete:true,slots:{...slots,QB:1,RB:0,SF:1},bench:1};
 const result=compareTrade({rows},input);assert.equal(result.roster.before_points,110);assert.equal(result.roster.after_points,95);assert.equal(result.roster.gain,-15);
});
test('explicit waiver additions and drops change the lineup but never change the trade packages',()=>{
 const board={rows:[player('a','RB',50),player('b','WR',70),player('star','RB',100),player('free','WR',90)]};
 const input={give:['a','b'],receive:['star'],rosterComplete:true,slots:{...slots,WR:1},bench:0};
 const first=compareTrade(board,input),filled=compareTrade(board,{...input,adds:['free']});assert.equal(first.roster.open_spots,1);assert.equal(first.roster.gain,-20);assert.equal(filled.roster.gain,70);assert.equal(first.edge,filled.edge);
});
test('invalid rosters and unavailable bench projections stop lineup claims',()=>{
 const rows=[player('a','RB',50),player('b','RB',70),{...player('u','WR',20),ros_points:null}];const input={give:['a'],receive:['b'],rosterComplete:true,slots,bench:3};
 for(const extra of [{retained:['a']},{retained:['b']},{adds:['a']},{drops:['missing']},{retained:['u']}])assert.equal(compareTrade({rows},{...input,...extra}).roster.gain,null);
 assert.throws(()=>tradeSlots({...slots,RB:1.5}),/whole numbers/);assert.throws(()=>compareTrade({rows},{...input,bench:-1}),/Bench/);
});
test('an ended ROS season yields zero lineup impact without inventing games',()=>{
 const rows=[player('a','RB',0,0,[]),player('b','RB',0,0,[])];const result=compareTrade({rows},{give:['a'],receive:['b'],slots,bench:0,rosterComplete:true});assert.equal(result.edge,0);assert.equal(result.roster.gain,0);assert.deepEqual(result.roster.weeks,[]);
});
