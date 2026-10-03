import {cpSync,mkdtempSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';

/** Keep the running preview's server and hashed browser assets together across test rebuilds. */
export function snapshotPreviewBuild(source,outputDirectory){
 mkdirSync(outputDirectory,{recursive:true});
 const snapshot=mkdtempSync(join(resolve(outputDirectory),'build-'));
 cpSync(source,snapshot,{recursive:true});
 return join(snapshot,'server','index.mjs');
}
