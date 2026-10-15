#!/usr/bin/env node
// Query the Gateway's live directory without sending a message or changing configuration.
import { loadNotifyConfig } from '../src/notify.mjs';
import { NotifyGatewayClient } from '../src/notify-client.mjs';
import { discoverNotifyChannels } from '../src/notify-discovery.mjs';

const args=process.argv.slice(2);
function option(name) {
  const index=args.indexOf(name);
  if(index<0)return undefined;
  if(!args[index+1]||args[index+1].startsWith('--'))throw new Error(`Missing value for ${name}`);
  return args[index+1];
}
const config=loadNotifyConfig();
const client=new NotifyGatewayClient(config.gateway);
try {
  await client.open();
  const result=await discoverNotifyChannels(client,{
    agentId:option('--agent')??config.gateway.agentId,query:option('--query')??'codex'
  });
  console.log(JSON.stringify(result,null,2));
} catch(error) {
  console.error(error.code?`Gateway ${error.code}`:'Channel discovery failed; check authorized connection and arguments');
  process.exitCode=1;
} finally {client.close();}
