import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { homedir,tmpdir } from 'node:os';
import { SessionInspector } from './notify-session-source.mjs';
import { confirmReplyDelivery } from './notify-reply-confirm.mjs';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export async function sendCliReply({router,key,token,baselineTurnId,inspector=new SessionInspector(),binary='/opt/homebrew/bin/codex',spawnProcess=spawn,timeoutMs=30*60_000}) {
  const r=router.get(key);
  if(r.state!=='prepared'||r.claimToken!==token)fail('REPLY_NOT_SENDABLE','This reply cannot be sent again');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.target.threadId))fail('INVALID_NATIVE_UUID','CLI resume requires the exact persisted UUID, never --last or a title');
  const before=await inspector.inspect(r.target);
  if(before.sourceRouting.kind!=='cli')fail('NOT_A_CLI_SESSION','Only positively identified native CLI sessions may use CLI resume; App/IDE/unknown sources are not a fallback');
  const baseline=before.native.turns.at(-1);
  if(!baseline||baseline.turnId!==baselineTurnId)fail('BASELINE_CHANGED','Native session changed; inspect it before resubmitting an input attempt');
  if(!['completed','interrupted','failed'].includes(baseline.status))fail('SESSION_BUSY','Latest persisted turn is not terminal; do not start a competing runner');
  if(!isAbsolute(binary)||!existsSync(binary))fail('CLI_BINARY_MISSING','Native Codex CLI is missing; input has not been attempted');
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>24*60*60_000)fail('INVALID_CLI_TIMEOUT','CLI timeout must be a bounded positive duration');
  // Classification is creation provenance, not a cross-process activity lease. The agent must also
  // honor known active owners/handoffs; notLoaded alone is never evidence that a client is idle.
  router.begin(key,token,baselineTurnId,{transport:'codex-cli-resume'});
  let started=false,exitCode=null,returnedThreadId=null,parseError=false;
  try {
    await new Promise((resolve,reject)=>{
      const child=spawnProcess(binary,['exec','resume','--json',r.target.threadId,'-'],{
        cwd:r.target.cwd,stdio:['pipe','pipe','pipe'],
        env:{HOME:homedir(),CODEX_HOME:r.target.home,PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',TMPDIR:tmpdir(),LANG:'en_US.UTF-8'}
      });
      let buffer='',settled=false;
      const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error){child.kill('SIGTERM');const k=setTimeout(()=>child.kill('SIGKILL'),1000);k.unref();child.once('exit',()=>clearTimeout(k));reject(error);}else resolve();};
      const timer=setTimeout(()=>finish(Object.assign(new Error('CLI turn timed out; inspect the exact native session before any retry'),{code:'CLI_REPLY_TIMEOUT'})),timeoutMs);
      child.once('spawn',()=>{started=true;});
      child.on('error',()=>finish(Object.assign(new Error('CLI runner failed to start; delivery needs reconciliation'),{code:'CLI_START_FAILED'})));
      child.stdin.on('error',()=>finish(Object.assign(new Error('CLI stdin closed; delivery outcome needs reconciliation'),{code:'CLI_STDIN_CLOSED'})));
      child.stderr.on('data',()=>{}); // Native diagnostics may contain credentials or project text.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        // Continue draining long outputs. Only bounded JSON envelopes are inspected.
        if(buffer.length+chunk.length>1024*1024){buffer='';parseError=true;return;}
        buffer+=chunk;
        while(buffer.includes('\n')){
          const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
          if(!line.trim())continue;
          try{const event=JSON.parse(line);if(event.type==='thread.started'&&typeof event.thread_id==='string')returnedThreadId=event.thread_id;}
          catch{parseError=true;}
        }
      });
      child.on('close',code=>{exitCode=code;finish();});
      // Original human reply goes only over stdin, never shell interpolation or process argv.
      child.stdin.end(r.content);
    });
    if(returnedThreadId&&returnedThreadId!==r.target.threadId)fail('CLI_WRONG_THREAD','CLI reported another thread; do not accept or create a replacement');
    const after=await inspector.inspect(r.target,{verifyInput:true});
    const turns=after.native.turns;
    const at=turns.findIndex(t=>t.turnId===baselineTurnId);
    if(at<0)fail('CLI_REPLY_UNCONFIRMED','Original baseline is outside the native verification window; input needs reconciliation');
    const candidates=turns.slice(at+1).filter(t=>t.messages?.some(m=>m.role==='user'&&!m.truncated&&m.text===r.content));
    if(candidates.length!==1)fail('CLI_REPLY_UNCONFIRMED','Could not uniquely verify this exact reply text in a new native turn');
    if(after.sourceRouting.kind!=='cli')fail('CLI_SOURCE_CHANGED','Native source changed during CLI input; inspect the session before confirming');
    const targetTurn=candidates[0];
    const existing=router.get(key);
    if(existing.state==='forwarded')return {...existing,sourceRouting:after.sourceRouting,execution:{exitCode,turnStatus:targetTurn.status,taskCompleted:targetTurn.status==='completed'}};
    const result=confirmReplyDelivery({router,key,token,native:after.native,sourceRouting:after.sourceRouting,receipt:{threadId:r.target.threadId,home:r.target.home,turnId:targetTurn.turnId,
      transport:'codex-cli-resume',evidence:'Fresh native CLI provenance; explicit exec resume UUID with raw stdin; exact original home/cwd; persisted new user turn matches reply text.',
      runnerExitCode:exitCode,turnStatus:targetTurn.status,sourceEvidence:before.sourceRouting.evidence,
      taskCompleted:targetTurn.status==='completed',streamParseWarning:parseError}});
    return {...result,sourceRouting:after.sourceRouting,execution:{exitCode,turnStatus:targetTurn.status,taskCompleted:targetTurn.status==='completed'}};
  }catch(error){
    try{const current=router.get(key);
      if(current.state==='sending')router.uncertain(key,token,`${error.code??'CLI_REPLY_FAILED'}; ${started?'runner started':'runner start unknown'}; inspect before retry`);
    }catch{} // Preserve verified delivery facts if the registration store itself is unavailable.
    throw error;
  }
}
