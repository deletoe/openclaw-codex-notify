import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySessionSource,SessionInspector } from '../src/notify-session-source.mjs';

test('source routing combines originator and source; vscode alone never proves desktop App',()=>{
  const cases=[
    [{source:'vscode',originator:'Codex Desktop'},'app'],
    [{source:'appServer',originator:'Codex Desktop'},'app'],
    [{source:'cli',originator:'codex_cli_rs'},'cli'],
    [{source:'exec',originator:'codex_exec'},'cli'],
    [{source:'cli',originator:'Codex Desktop'},'unknown'],
    [{source:'vscode'},'unknown'],
    [{source:'vscode',originator:'codex_vscode'},'ide'],
    [{source:'vscode',originator:'codex_cli_rs'},'unknown'],
    [{source:'exec'},'unknown'],
    [{source:'appServer',originator:'custom-integration'},'unknown'],
    [{source:{subAgent:'parent'},originator:'Codex Desktop'},'unknown'],
    [{source:'cli',originator:'codex_cli_rs',ephemeral:true},'unknown']
  ];
  for(const [data,expected]of cases){const r=classifySessionSource(data);assert.equal(r.kind,expected,JSON.stringify(data));assert.equal(r.activity,'unknown');if(['unknown','ide'].includes(expected))assert.equal(r.inputTransport,null);}
});
test('source metadata must belong to the exact native target, not a same-title session',async()=>{
  const target={threadId:'one',cwd:process.cwd(),home:'/native/home'};
  const good=new SessionInspector({metadataReader:async()=>({id:'one',cwd:process.cwd(),source:'cli',originator:'codex_cli_rs'})});
  assert.equal((await good.classify(target)).kind,'cli');
  const wrong=new SessionInspector({metadataReader:async()=>({id:'different',cwd:process.cwd(),source:'cli',originator:'codex_cli_rs'})});
  await assert.rejects(wrong.classify(target),{code:'WRONG_TARGET'});
});
