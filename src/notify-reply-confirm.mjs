import { createHash } from 'node:crypto';

const digest=text=>createHash('sha256').update(text,'utf8').digest('hex');
export function compareReplyText(expected,observed,{allowAppTrailingLf=false}={}) {
  if(typeof expected!=='string'||typeof observed!=='string')return {matched:false,kind:'invalid-text'};
  // Never trim, normalize line endings, remove spaces, or rewrite the stored human message.
  const kind=observed===expected?'exact':allowAppTrailingLf&&observed===expected+'\n'?'app-added-single-lf':'different';
  return {matched:kind!=='different',kind,expectedSha256:digest(expected),observedSha256:digest(observed),
    expectedBytes:Buffer.byteLength(expected),observedBytes:Buffer.byteLength(observed),
    ...(kind==='app-added-single-lf'?{extraSuffixHex:'0a'}:{})};
}
const failure=(code,message,details={})=>Object.assign(new Error(message),{code,
  deliveryStatus:'unverified',registrationStatus:'pending',taskStatus:'unknown',inputRetryAllowed:false,...details});

// Only records an already observed input. It never controls the App or starts/resumes a turn.
export function confirmReplyDelivery({router,key,token,receipt,native,sourceRouting}) {
  const r=router.get(key);
  if(r.claimToken!==token)throw failure('REPLY_NOT_IN_FLIGHT','No matching reply owner');
  if(!['sending','uncertain','forwarded'].includes(r.state))throw failure('REPLY_NOT_IN_FLIGHT','No input attempt to reconcile');
  if(receipt?.threadId!==r.target.threadId||receipt?.home!==r.target.home||native?.threadId!==r.target.threadId)
    throw failure('WRONG_REPLY_TARGET','Receipt and native snapshot must refer to the exact original home/thread');
  if(r.state==='forwarded') {
    if(r.receipt?.threadId!==receipt.threadId||r.receipt?.home!==receipt.home||r.receipt?.turnId!==receipt.turnId)
      throw failure('REPLY_ALREADY_REGISTERED','Reply was already registered with a different receipt',{deliveryStatus:'delivered',registrationStatus:'registered'});
    return {...r,deliveryStatus:'delivered',registrationStatus:'registered',inputRetryAllowed:false,alreadyRegistered:true,
      taskStatus:native.turns?.find(t=>t.turnId===receipt.turnId)?.status??'unknown',textMatch:r.receipt.textMatch??null};
  }
  const turns=native.turns??[],baseline=turns.findIndex(t=>t.turnId===r.baselineTurnId),index=turns.findIndex(t=>t.turnId===receipt.turnId);
  if(baseline<0||index<=baseline)throw failure('REPLY_TURN_UNVERIFIED','The target must be a persisted turn after the recorded baseline; never resend to repair registration');
  const turn=turns[index],taskStatus=turn.status??'unknown';
  const allowAppTrailingLf=r.inputTransport==='openclaw-computer-use'&&sourceRouting?.kind==='app';
  const matches=(turn.messages??[]).filter(m=>m.role==='user'&&!m.truncated).map(m=>compareReplyText(r.content,m.text,{allowAppTrailingLf})).filter(m=>m.matched);
  if(matches.length!==1)throw failure('REPLY_TEXT_UNVERIFIED','Could not uniquely match the persisted user text; retain original/native evidence and do not resend',{taskStatus});
  const textMatch=matches[0];
  const facts={deliveryStatus:'delivered',registrationStatus:'pending',taskStatus,inputRetryAllowed:false,
    deliveredThreadId:r.target.threadId,deliveredTurnId:turn.turnId,textMatch};
  const registeredReceipt={...receipt,transport:r.inputTransport==='source-check-required'?receipt.transport:r.inputTransport,
    verifiedBy:'native-readonly-reader',textMatch,turnStatus:taskStatus,taskCompleted:taskStatus==='completed'};
  try {
    const result=router.confirm(key,token,registeredReceipt);
    return {...result,...facts,registrationStatus:'registered'};
  } catch(error) {
    throw failure('REPLY_REGISTRATION_FAILED','Input is already persisted in the original session, but registration failed. Retry registration only; never resend input.',
      {...facts,registrationRetryAllowed:true,registrationErrorCode:error.code??'REGISTRATION_ERROR'});
  }
}

export function replyErrorOutput(error) {
  const output={code:error.code??'REPLY_ERROR',message:error.message};
  for(const key of ['deliveryStatus','registrationStatus','taskStatus','inputRetryAllowed','registrationRetryAllowed','registrationErrorCode','deliveredThreadId','deliveredTurnId','textMatch'])
    if(error[key]!==undefined)output[key]=error[key];
  return output;
}
