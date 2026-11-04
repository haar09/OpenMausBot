import {constants} from 'node:fs';
import {chmod,lstat,mkdir,open,readFile,rename,rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const dataDir=process.env.OMB_DATA_DIR??join(homedir(),'.openmausbot');
const authDir=join(dataDir,'aws-auth');
async function directory(path){
 try{await mkdir(path,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('AWS setup requires a real directory: '+path);
}
async function replaceFile(path,content){
 const temp=join(dirname(path),'.aws-setup-'+randomUUID());let file;
 try{
  file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  await file.writeFile(content);await file.close();file=null;await rename(temp,path);await chmod(path,0o600);
 }finally{if(file)await file.close();await rm(temp,{force:true});}
}
export async function prepareAwsWorkspace(workspace){
 const root=resolve(workspace);let settings,selectedAuthDir=authDir,dedicatedIdentity=false;
 if(/^[a-f0-9]{16}$/.test(basename(root))&&root===join(dataDir,'vm-homes',basename(root))){
  const ownDir=join(authDir,'identities',basename(root));
  try{settings=JSON.parse(await readFile(join(ownDir,'settings.json'),'utf8'));if(settings.dedicatedWorkspace!==root)throw Error('Dedicated AWS identity does not match this workspace.');selectedAuthDir=ownDir;dedicatedIdentity=true;}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 if(!settings)try{settings=JSON.parse(await readFile(join(authDir,'settings.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return {enabled:false};throw e;}
 if(settings.enabled!==true)return {enabled:false};
 if(!/^\d{12}$/.test(settings.account)||!new RegExp('^arn:aws:iam::'+settings.account+':role/[A-Za-z0-9+=,.@_/-]+$').test(settings.roleArn))throw Error('Invalid AWS role metadata.');
 const source=JSON.parse(await readFile(join(selectedAuthDir,'source-credentials.json'),'utf8'));
 if(!/^[A-Z0-9]{16,128}$/.test(source.aws_access_key_id)||!/^[A-Za-z0-9/+=]{30,128}$/.test(source.aws_secret_access_key))throw Error('Invalid AWS broker credential format.');
 await directory(root);let path=root;
 for(const part of ['.desktop-apps','local','share','openmausbot-aws']){path=join(path,part);await directory(path);}
 await chmod(path,0o700);
 const session='omb-'+basename(root).replace(/[^A-Za-z0-9+=,.@_-]/g,'-').slice(0,48);
 const profileLines=[];
 if(settings.administration===true){
  if(!dedicatedIdentity)throw Error('AWS administration requires a dedicated bot identity.');
  profileLines.push('[profile aws-management]','role_arn = '+settings.roleArn,'source_profile = omb-source','role_session_name = atlas-'+basename(root),'duration_seconds = '+settings.sessionSeconds,'region = '+settings.region,'output = json','sts_regional_endpoints = regional','');
 }
 if(settings.vulpinDebug?.enabled===true){
  const debug=settings.vulpinDebug;
  if(!new RegExp('^arn:aws:iam::'+settings.account+':role/[A-Za-z0-9+=,.@_/-]+$').test(debug.roleArn)||debug.region!=='eu-central-1')throw Error('Invalid Vulpin debug role metadata.');
  profileLines.push('[profile vulpin-debug]','role_arn = '+debug.roleArn,'source_profile = omb-source','role_session_name = vulpin-'+basename(root).replace(/[^A-Za-z0-9+=,.@_-]/g,'-').slice(0,48),'duration_seconds = '+settings.sessionSeconds,'region = '+debug.region,'output = json','sts_regional_endpoints = regional','');
 }
 const config=['[default]','role_arn = '+settings.roleArn,'source_profile = omb-source','role_session_name = '+session,'duration_seconds = '+settings.sessionSeconds,'region = '+settings.region,'output = json','sts_regional_endpoints = regional','','[profile omb-source]','region = '+settings.region,'',...profileLines].join('\n');
 const credentials=['[omb-source]','aws_access_key_id = '+source.aws_access_key_id,'aws_secret_access_key = '+source.aws_secret_access_key,''].join('\n');
 await replaceFile(join(path,'config'),config);await replaceFile(join(path,'credentials'),credentials);
 if(settings.administration===true)await replaceFile(join(path,'README.md'),await readFile(join(selectedAuthDir,'administration-guide.md'),'utf8'));
 else if(settings.vulpinDebug?.enabled===true)await replaceFile(join(path,'README.md'),await readFile(join(selectedAuthDir,'vulpin-debug-guide.md'),'utf8'));
 return {enabled:true,account:settings.account,roleArn:settings.roleArn,session,vulpinDebug:settings.vulpinDebug?.enabled===true,administration:settings.administration===true,dedicatedIdentity};
}
