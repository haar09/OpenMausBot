import {constants} from 'node:fs';
import {chmod,lstat,mkdir,open,readFile,rename,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const dataDir=process.env.OMB_DATA_DIR??join(homedir(),'.openmausbot');
const authDir=join(dataDir,'git-auth');
const guestDir='/home/cua/.local/share/openmausbot-git';
const quote=value=>JSON.stringify(String(value));

async function realDirectory(path){
 try{await mkdir(path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 const info=await lstat(path);
 if(!info.isDirectory()||info.isSymbolicLink())throw Error('Git setup requires an ordinary directory: '+path);
}

async function replacePrivateFile(path,contents){
 const temp=join(dirname(path),'.git-setup-'+randomUUID());
 let handle;
 try{
  handle=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  await handle.writeFile(contents);await handle.close();handle=null;
  await rename(temp,path);await chmod(path,0o600);
 }finally{if(handle)await handle.close();await rm(temp,{force:true});}
}

export async function prepareGitWorkspace(workspace){
 let settings;
 try{settings=JSON.parse(await readFile(join(authDir,'settings.json'),'utf8'));}
 catch(error){if(error.code==='ENOENT')return {enabled:false};throw error;}
 if(settings.enabled!==true)return {enabled:false};
 if(!/^[A-Za-z0-9-]+$/.test(settings.githubLogin)||!/^\d+$/.test(settings.githubId))throw Error('Invalid shared Git account metadata.');
 const root=resolve(workspace);
 await realDirectory(root);
 let folder=root;
 for(const part of ['.desktop-apps','local','share','openmausbot-git']){folder=join(folder,part);await realDirectory(folder);}
 await chmod(folder,0o700);
 for(const name of ['id_ed25519','id_ed25519.pub','known_hosts']){
  // Contents stay on the server and are never logged or returned.
  await replacePrivateFile(join(folder,name),await readFile(join(authDir,name)));
 }
 const sshConfig=[
  'Host github.com ssh.github.com',
  '    HostName ssh.github.com',
  '    Port 443',
  '    User git',
  '    IdentityFile '+guestDir+'/id_ed25519',
  '    UserKnownHostsFile '+guestDir+'/known_hosts',
  '    HostKeyAlias github.com',
  '    IdentitiesOnly yes',
  '    StrictHostKeyChecking yes',
  '    BatchMode yes',
  'Host *',
  '    Include /home/cua/.ssh/config',
  '    Include /etc/ssh/ssh_config',''
 ].join('\n');
 const gitConfig=[
  '[user]',
  '    name = '+quote(settings.authorName??'OpenMausBot'),
  '    email = '+quote(settings.githubId+'+'+settings.githubLogin+'@users.noreply.github.com'),
  '[core]',
  '    sshCommand = '+quote('ssh -F '+guestDir+'/ssh_config'),
  '[url "git@github.com:"]',
  '    insteadOf = https://github.com/',''
 ].join('\n');
 await replacePrivateFile(join(folder,'ssh_config'),sshConfig);
 await replacePrivateFile(join(folder,'gitconfig'),gitConfig);
 return {enabled:true,githubLogin:settings.githubLogin};
}
