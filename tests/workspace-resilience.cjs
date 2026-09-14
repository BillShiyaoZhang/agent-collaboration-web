// Manual loopback fixture check; run workspace-browser.cjs first to populate two saved conversations.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base='http://127.0.0.1:3061';
const output=path.resolve(__dirname,'../build/workspace-sync-preview');fs.mkdirSync(output,{recursive:true});
const get=async route=>{const r=await fetch(base+route);assert.equal(r.status,200);return r.json();};
const post=async(route,data={})=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(r.status,200);return r.json();};
async function until(check,timeout=60000){const end=Date.now()+timeout;while(Date.now()<end){try{const r=await check();if(r)return r;}catch{}await new Promise(r=>setTimeout(r,500));}throw new Error('Timed out waiting for fixture condition');}
async function main(){
 const checks=[];
 await until(async()=>{const s=await get('/fixture/db');return s.states.every(row=>row.status==='ready');});
 await post('/fixture/mode',{offline:true,due:true,expireCapabilities:true});
 await until(async()=>{const s=await get('/fixture/db');return s.states.every(row=>row.status==='offline');});
 const before=await get('/fixture/account-check');
 assert.equal(before.status,200);assert.equal(before.otherAccountStatus,404);assert.ok(before.hasContacts&&before.inboxCount>0&&before.conversationCount>=2&&before.completedTurns>0);
 assert.equal(before.sync.status,'offline');checks.push('Agent platform offline: authenticated API retains contacts, messages and conversations; other account remains inaccessible');
 await post('/fixture/restart');
 const after=await until(async()=>{const state=await get('/fixture/account-check');return state.status===200&&state;});
 assert.ok(after.hasContacts&&after.inboxCount===before.inboxCount&&after.conversationCount===before.conversationCount&&after.completedTurns===before.completedTurns);
 checks.push('New Next server process restores the same saved history while remote platform remains offline');
 const previousSends=(await get('/fixture/summary')).calls.filter(c=>c.method==='conversation.send').length;
 await post('/fixture/mode',{offline:false,extraMessage:true,due:true,expireCapabilities:true});
 await until(async()=>{const s=await get('/fixture/db');return s.items.filter(row=>row.kind==='inbox'&&row.count>=2).length===3;});
 const final=await get('/fixture/account-check');assert.ok(final.inboxCount>=2);
 assert.equal((await get('/fixture/summary')).calls.filter(c=>c.method==='conversation.send').length,previousSends);
 checks.push('After recovery all three connections receive new data without browser pages and without re-sending prior messages');
 const result={passed:true,checks};fs.writeFileSync(path.join(output,'resilience-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;});

