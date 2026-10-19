/** Full default suite uses only a disposable local catalogue; denies external fetch. */
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {productLocalHarness} from '../helpers/productLocalHarness.mjs';
import {productStripeMock} from '../helpers/productStripeMock.mjs';
const baseline=JSON.parse(fs.readFileSync('outputs/product-083/baseline.json'));
const harness=await productLocalHarness(baseline.database,productStripeMock().adapter);
const out='outputs/product-083';
try{
 const env={...process.env,...harness.build,STRIPE_SECRET_KEY:'',RESEND_API_KEY:'',SUPABASE_SECRET_KEY:'',
  NODE_OPTIONS:'--import ./tests/helpers/localOnlyFetch.mjs'};
 const fd=fs.openSync(out+'/npm-test.log','w');
 const command=process.argv.includes('--tests-only')?JSON.parse(fs.readFileSync('package.json')).scripts.test.replace('npm run build && ',''):'npm.cmd test';
 const code=await new Promise((resolve,reject)=>{
  const child=spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-Command',command],{env,stdio:['ignore',fd,fd],windowsHide:true});
  child.on('error',reject);child.on('close',resolve);
 });
 fs.closeSync(fd);fs.writeFileSync(out+'/npm-result.json',JSON.stringify({exitCode:code,externalFetchDenied:true,database:baseline.database},null,2));
 console.log('npm test exit:',code,'log:',out+'/npm-test.log');process.exitCode=code??1;
}finally{harness.close();}
