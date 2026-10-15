import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverNotifyChannels } from '../src/notify-discovery.mjs';

test('discovery finds a channel owned outside the default agent and combines duplicate routes',async()=>{
  const calls=[];
  const channel={channel:'discord',kind:'channel',accountId:'default',target:'channel:1000000000000000005',label:'codex'};
  const client={async request(method,params){
    calls.push({method,params});
    if(method==='agents.list')return {defaultId:'main',agents:[{id:'main'},{id:'codex-ops'},{id:'other'}]};
    return {conversations:params.agentId==='main'?[]:[channel]};
  }};
  const result=await discoverNotifyChannels(client);
  assert.deepEqual(result.agentsSearched,['main','codex-ops','other']);
  assert.equal(result.conversations.length,1);
  assert.deepEqual(result.conversations[0].agentIds,['codex-ops','other']);
  assert.equal(calls[2].params.query,'codex');
  assert.equal(result.possiblyTruncated,false);
  calls.length=0;
  await discoverNotifyChannels(client,{agentId:'codex-ops'});
  assert.equal(calls.length,1);assert.equal(calls[0].method,'conversations.list');
});
