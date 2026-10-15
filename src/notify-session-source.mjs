import { ReadOnlyRpc, discoverCodex, ReadOnlyCodex } from './readonly-codex.mjs';
import { realpathSync } from 'node:fs';

// Native source=vscode is shared by the desktop App and IDE clients. Never map it alone to App.
export function classifySessionSource(thread) {
  const source=typeof thread?.source==='string'?thread.source:null;
  const originator=typeof thread?.originator==='string'?thread.originator:null;
  const name=originator?.trim().toLowerCase();
  const evidence={source,originator,threadSource:thread?.threadSource??null,ephemeral:thread?.ephemeral??null};
  const result=(kind,inputTransport,reason)=>({kind,inputTransport,reason,evidence,basis:'persisted-creation-metadata',activity:'unknown'});
  if(thread?.ephemeral===true)return result('unknown',null,'ephemeral-session');
  const desktop=['codex desktop','codex app','chatgpt desktop','chatgpt app'].includes(name);
  const cli=['codex_cli_rs','codex_cli','codex-cli','codex_exec'].includes(name);
  if(desktop&&['cli','exec'].includes(source))return result('unknown',null,'conflicting-source-and-desktop-originator');
  if(desktop&&['vscode','appServer'].includes(source))return result('app','openclaw-computer-use','desktop-originator-with-compatible-native-source');
  if(cli&&['cli','exec'].includes(source))return result('cli','codex-cli-resume','explicit-cli-source-and-originator');
  if(source==='vscode'&&['codex_vscode','codex vscode','vscode'].includes(name))return result('ide',null,'ide-is-not-a-confirmed-cli-or-desktop-app-session');
  return result('unknown',null,'missing-or-unrecognized-native-source-evidence');
}

export class SessionInspector {
  constructor({binary,metadataReader,historyReader}={}) {this.binary=binary;this.metadataReader=metadataReader;this.historyReader=historyReader;}
  async metadata(target) {
    const thread=this.metadataReader?await this.metadataReader(target):
      (await new ReadOnlyRpc({binary:this.binary??discoverCodex(),codexHome:target.home,cwd:target.cwd}).call('thread/read',{threadId:target.threadId,includeTurns:false})).thread;
    if(thread?.id!==target.threadId||realpathSync(thread.cwd)!==realpathSync(target.cwd))throw Object.assign(new Error('Native metadata does not match the bound home/thread/cwd'),{code:'WRONG_TARGET'});
    return thread;
  }
  async classify(target) { return classifySessionSource(await this.metadata(target)); }
  async inspect(target,{verifyInput=false}={}) {
    const sourceRouting=await this.classify(target);
    const native=this.historyReader?await this.historyReader(target):await new ReadOnlyCodex({project:{name:target.title,path:target.cwd},readonlyCodex:{home:target.home,...(this.binary?{binary:this.binary}:{})}}).read(target.threadId,{limit:50,...(verifyInput?{maxTextChars:30000,prioritizeUserInput:true}:{})});
    return {native,sourceRouting};
  }
}
