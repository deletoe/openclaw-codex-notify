#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { loadNotifyConfig } from './notify.mjs';
import { NotifyStore } from './notify-store.mjs';
import { ReplyRouter } from './notify-replies.mjs';
import { GatewaySender } from './notify-gateway.mjs';
import { SessionInspector } from './notify-session-source.mjs';
import { sendCliReply } from './notify-cli-reply.mjs';
import { confirmReplyDelivery,replyErrorOutput } from './notify-reply-confirm.mjs';
import { discoverCodexCli } from './readonly-codex.mjs';

let store;
try {
  const {values:o,positionals:[command,...rest]}=parseArgs({allowPositionals:true,options:{file:{type:'string'},'message-id':{type:'string'},'channel-id':{type:'string'},account:{type:'string'},key:{type:'string'},token:{type:'string'},'baseline-turn':{type:'string'},apply:{type:'boolean'}}});
  if(rest.length)throw new Error('Unexpected positional arguments');
  const c=loadNotifyConfig();
  store=new NotifyStore(c.stateDir);
  const router=new ReplyRouter(store,new GatewaySender(c.gateway).destination(),{allowedSenderIds:c.replies?.allowedSenderIds});
  const data=o.file?JSON.parse(readFileSync(o.file,'utf8')):null;
  const inspector=new SessionInspector({binary:c.replies?.readerBinary});
  const inspect=async (r,options)=>await inspector.inspect(r.target,options);
  const enrich=async r=>{
    if(!r?.matched)return r;
    let sourceRouting;try{sourceRouting=await inspector.classify(r.target);}catch{sourceRouting={kind:'unknown',inputTransport:null,reason:'native-source-metadata-unavailable'};}
    return {...r,sourceRouting,inputTransport:r.state&&['sending','uncertain','forwarded'].includes(r.state)?r.inputTransport:sourceRouting.inputTransport,
      ...(Object.hasOwn(r,'canSend')?{canSend:r.canSend&&['cli','app'].includes(sourceRouting.kind)}:{})};
  };
  let result;
  switch(command){
    case 'reply-resolve': result=await enrich(router.resolve({messageId:o['message-id'],channelId:o['channel-id'],accountId:o.account}));break;
    case 'reply-index': result=router.indexExisting({messageIds:data?.messageIds??[o['message-id']],apply:o.apply===true});break;
    case 'reply-prepare': if(!data)throw new Error('reply-prepare requires --file with normalized native Discord input');result=await enrich(router.prepare(data));break;
    case 'reply-status': result=await enrich(router.get(o.key));break;
    case 'reply-read': {const r=router.get(o.key);result={route:r,...await inspect(r)};break;}
    case 'reply-send-cli': result=await sendCliReply({router,key:o.key,token:o.token,baselineTurnId:o['baseline-turn'],inspector,binary:discoverCodexCli({binary:c.replies?.cliBinary}),timeoutMs:c.replies?.cliTimeoutMs??30*60_000});break;
    case 'reply-begin': {
      const {native,sourceRouting}=await inspect(router.get(o.key));
      if(sourceRouting.kind!=='app')throw new Error('App UI begin is only for positively identified App sessions; CLI uses reply-send-cli, unknown/IDE sources require clarification');
      if(native.turns.at(-1)?.turnId!==o['baseline-turn'])throw new Error('Native session changed since the baseline; inspect the App again before input');
      result={...router.begin(o.key,o.token,o['baseline-turn']),sourceRouting};break;
    }
    case 'reply-confirm': {
      if(!data)throw new Error('reply-confirm requires --file with verified App receipt');
      const r=router.get(o.key),{native,sourceRouting}=await inspect(r,{verifyInput:true});
      result=confirmReplyDelivery({router,key:o.key,token:o.token,receipt:data,native,sourceRouting});break;
    }
    case 'reply-uncertain': result=router.uncertain(o.key,o.token,data?.reason);break;
    default:throw new Error('Unknown reply command');
  }
  console.log(JSON.stringify(result,null,2));
}catch(e){console.error(JSON.stringify(replyErrorOutput(e)));process.exitCode=1;}
finally{store?.close();}
