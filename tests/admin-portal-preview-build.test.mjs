import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {snapshotPreviewBuild} from './helpers/adminPortalPreviewBuild.mjs';

test('preview keeps matching server and browser assets when tests replace the source build',()=>{
 const root=mkdtempSync(join(tmpdir(),'gloa-preview-'));
 try{
  const source=join(root,'source');
  mkdirSync(join(source,'server'),{recursive:true});mkdirSync(join(source,'public'),{recursive:true});
  writeFileSync(join(source,'server','index.mjs'),'old manifest');writeFileSync(join(source,'public','old.js'),'old browser bundle');
  const entry=snapshotPreviewBuild(source,join(root,'snapshots'));
  rmSync(source,{recursive:true});mkdirSync(source);writeFileSync(join(source,'new.js'),'new build');
  assert.equal(readFileSync(entry,'utf8'),'old manifest');
  assert.equal(readFileSync(join(dirname(entry),'..','public','old.js'),'utf8'),'old browser bundle');
 }finally{rmSync(root,{recursive:true,force:true});}
});
