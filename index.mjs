// Registration is inert: installation and pairing happen only in explicit CLI commands.
import {dirname} from 'node:path';
export default {
  id:'codex-notify',name:'Codex Notify',
  register(api){
    api.registerCli(async({program})=>{
      const {registerCommands}=await import('./cli.mjs');
      registerCommands(program,{configPath:api.pluginConfig?.configPath,
        packageRoot:api.rootDir??(typeof api.source==='string'?dirname(api.source):undefined)});
    },{descriptors:[{name:'codex-notify',description:'Manage local Codex timeout reminders',hasSubcommands:true}]});
  }
};
