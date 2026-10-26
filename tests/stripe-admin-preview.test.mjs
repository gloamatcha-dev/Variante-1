import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {previewModes,syntheticSync,previewResponse} from './helpers/stripeAdminPreview.mjs';
test('every preview sync action is simulated and no scenario enables a real run',()=>{
 for(const mode of previewModes){const r=previewResponse('/api/admin/stripe-sync',{action:'run'},mode);assert.equal(r.status,409);assert.ok(r.data.error);}
 assert.equal(previewResponse('/api/admin/stripe-sync',{action:'status'},'outage').status,503);
 for(const mode of ['disabled','running','retry','overdue','incomplete'])assert.equal(syntheticSync(mode).verified,false);
 assert.equal(syntheticSync('complete').verified,true);
 assert.equal(syntheticSync('complete',Date.parse('2026-10-24T12:00:00Z')).next_scheduled_at,'2026-10-25T05:40:00.000Z');
});
test('preview isolates environment/network and blocks business mutation transport',()=>{
 assert.equal(previewResponse('/api/admin/orders',{action:'refund'}).status,409);
 assert.equal(previewResponse('/api/admin/products',{action:'publish'}).status,409);
 const server=fs.readFileSync('tests/runtime/stripe-admin-preview.mjs','utf8');
 assert.match(server,/configFile:false,envFile:false,envDir:false/);assert.match(server,/host:'127.0.0.1'/);assert.match(server,/connect-src 'none'/);
 assert.doesNotMatch(server,/supabaseAdmin|runFinanceSyncServer|STRIPE_SECRET_KEY/);
 const client=fs.readFileSync('tests/preview/stripe-admin/main.jsx','utf8');assert.match(client,/window.fetch=async/);assert.doesNotMatch(client,/nativeFetch|fetch\.bind/);
});
