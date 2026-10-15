// Discord routes may belong to a non-default agent; search each visible owner.
export async function discoverNotifyChannels(client,{agentId,query='codex'}={}) {
  let agentIds=agentId?[agentId]:[];
  if(!agentId){
    const result=await client.request('agents.list',{});
    agentIds=[...new Set([result.defaultId,...(result.agents??[]).map(a=>a.id)].filter(Boolean))];
    if(!agentIds.length)throw new Error('Gateway returned no visible agents');
  }
  const candidates=new Map();let possiblyTruncated=false;
  for(const owner of agentIds){
    const result=await client.request('conversations.list',{agentId:owner,channel:'discord',query,limit:100});
    if(!Array.isArray(result.conversations))throw new Error('Gateway returned an invalid directory');
    possiblyTruncated ||= result.conversations.length===100;
    for(const item of result.conversations){
      if(item.channel!=='discord'||item.kind!=='channel')continue;
      const key=JSON.stringify([item.accountId,item.target,item.threadId??null]);
      const found=candidates.get(key);
      if(found)found.agentIds.push(owner);
      else candidates.set(key,{...item,agentIds:[owner]});
    }
  }
  return {agentsSearched:agentIds,possiblyTruncated,conversations:[...candidates.values()]};
}
