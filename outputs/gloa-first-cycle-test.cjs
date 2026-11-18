// Targeted contract test against a fresh loopback-only PostgreSQL 17 cluster.
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const bin = 'C:/Program Files/PostgreSQL/17/bin';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloa-first-cycle-'));
const account = 'acct_1U6B3ODI76FH9qsq';
const job = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const draft = fs.readFileSync('outputs/gloa-first-cycle-NOT-AUTHORIZED.sql', 'utf8');
const lockWaitOnly = process.argv.includes('--lock-wait');
function run(tool, args, input) {
  return spawnSync(path.join(bin, tool + '.exe'), args, {input, encoding: 'utf8', timeout: 30000, windowsHide: true});
}
function ok(result) {
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
}
(async () => {
  if (!lockWaitOnly) {
  const {financeScanBudget} = require('../lib/financeScanBudget.ts');
  let sends = 0;
  const budget = financeScanBudget(async () => { sends++; return {}; }, {maxReads:2,minReadIntervalMs:15});
  await budget.read('/test',{});
  const pending = await Promise.allSettled(Array.from({length:4}, () => budget.read('/test',{})));
  assert.equal(pending.filter(result => result.status==='fulfilled').length,1);
  assert.equal(sends,2);
  const ended = financeScanBudget(async () => { assert.fail('expired provider call'); }, {budgetMs:0});
  await assert.rejects(ended.read('/test',{}), /finance_sync_yield/);
  }

  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const args = ['-X', '-w', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'];
  const sql = statement => run('psql', args, statement);
  const asyncSql = statement => new Promise((resolve, reject) => {
    const child = spawn(path.join(bin, 'psql.exe'), args, {windowsHide:true});
    let output = '';
    let errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    child.on('error', reject);
    child.on('close', status => resolve({status,stdout:output,stderr:errors}));
    child.stdin.end(statement);
  });
  const parallelSql = async statement => JSON.parse(ok(await asyncSql(statement)));
  async function observe(query) {
    for (let i=0; i<30; i++) {
      if (ok(sql(query))==='t') return;
      await new Promise(resolve => setTimeout(resolve,50));
    }
    assert.fail('Expected blocking lock was not observed');
  }
  const request = mode => `SELECT public.finance_sync_cycle_reserve_v1('${account}','${mode}',false);`;
  let server;
  let log;
  try {
    ok(run('initdb', ['-D', dir, '-U', 'postgres', '-A', 'trust', '--no-locale']));
    log = fs.openSync(path.join(dir, 'server.log'), 'a');
    server = spawn(path.join(bin, 'postgres.exe'), ['-D', dir, '-h', '127.0.0.1', '-p', String(port)], {windowsHide:true,stdio:['ignore',log,log]});
    let startupError;
    server.on('error', error => { startupError = error; });
    for (let i=0; i<40; i++) {
      if (startupError) throw startupError;
      if (sql('SELECT 1').status===0) break;
      await new Promise(resolve => setTimeout(resolve,250));
    }
    ok(sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE public.finance_sync_config(account_id text primary key, enabled boolean, auto_open_current_period boolean, scan_from timestamptz);
      CREATE TABLE public.finance_sync_jobs(id uuid primary key, account_id text, scan_from timestamptz, state text, lease_until timestamptz, checkpoint jsonb);
      CREATE TABLE public.finance_sync_audits(state text);
      CREATE TABLE public.finance_sync_periods(account_id text, month date, status text);
      CREATE TABLE public.finance_sync_sources(account_id text, source_key text, original_on date);
      CREATE TABLE public.finance_sync_approvals(account_id text, source_key text, posting_on date);
      CREATE TABLE public.finance_sync_read_usage(id uuid default gen_random_uuid(), account_id text, actual integer, scan_mode text, job_reads jsonb);
      CREATE FUNCTION public.finance_sync_read_reserve_v2(p_account text,p_requested integer DEFAULT 80) RETURNS jsonb LANGUAGE sql AS $$
        INSERT INTO public.finance_sync_read_usage(account_id) VALUES(p_account)
        RETURNING jsonb_build_object('id',id,'granted',least(7,p_requested));
      $$;
      CREATE FUNCTION public.finance_first_scan_isolated_v3() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
      CREATE FUNCTION public.money_before_first_v3() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
      CREATE TABLE public.synthetic_money_effects(source_key text);
      CREATE SEQUENCE public.synthetic_writer_entries;
      CREATE FUNCTION public.finance_sync_source_read_v1(text,text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
      CREATE FUNCTION public.finance_sync_record_before_first_v3(p_job uuid,p_token uuid,p_key text)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
      DECLARE v_kind text:='payment'; amt int:=1; paid int:=1; f record; j record; r jsonb:='{}';
      BEGIN
        SELECT NULL::uuid AS id INTO f;
        SELECT account_id INTO j FROM public.finance_sync_jobs WHERE id=p_job;
        PERFORM 1 FROM public.finance_sync_periods WHERE account_id=j.account_id FOR SHARE;
  if v_kind='payment' then
   if amt<>paid then RAISE EXCEPTION 'mock amount mismatch'; END IF;
   PERFORM nextval('public.synthetic_writer_entries');
   IF p_key='nested' THEN PERFORM pg_advisory_xact_lock(54471); END IF;
   INSERT INTO public.synthetic_money_effects VALUES (p_key);
  END IF;
 if v_kind='payment_fee' and f.id is not null then NULL; END IF;
 if v_kind='payment' and r->>'verifiedFeeCents'='0' then NULL; END IF;
 return public.finance_sync_source_read_v1(j.account_id,p_key)||jsonb_build_object('result','recorded');
      END $$;
      REVOKE ALL ON FUNCTION public.finance_sync_record_before_first_v3(uuid,uuid,text) FROM PUBLIC;
      CREATE FUNCTION public.finance_sync_record_v1(p_job uuid,p_token uuid,p_key text)
      RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN
       if public.finance_first_scan_isolated_v3() then raise exception 'first_scan_money_forbidden';end if;
       RETURN public.finance_sync_record_before_first_v3(p_job,p_token,p_key); END $$;
      ${[
        ['stage','jsonb'],['failure','text'],
      ].map(([name,type])=>`CREATE FUNCTION public.finance_sync_${name}_v1(p_job uuid,p_token uuid,${name==='stage'?'p_receipt':'p_key'} ${type})
       RETURNS integer LANGUAGE plpgsql AS $$ BEGIN
       if public.finance_first_scan_isolated_v3() then raise exception 'first_scan_money_forbidden';end if;
       RETURN public.money_before_first_v3(); END $$;`).join('\n')}
      INSERT INTO public.finance_sync_config VALUES ('${account}',false,false,'2026-11-12T23:00:00Z');
      INSERT INTO public.finance_sync_periods VALUES ('${account}','2026-11-01','open');
      INSERT INTO public.finance_sync_jobs VALUES ('${job}','${account}','2026-11-12T23:00:00Z','completed',now(),'{"verified":true}');
    `));
    ok(sql(draft));
    if (lockWaitOnly) {
      ok(sql(`INSERT INTO public.finance_sync_sources VALUES ('${account}','period','2026-11-15'),('${account}','nested','2026-11-15');`));
      for (const [source, lock] of [
        ['period', 'SELECT 1 FROM public.finance_sync_periods FOR UPDATE'],
        ['nested', 'SELECT pg_advisory_xact_lock(54471)'],
      ]) {
        const holder = asyncSql(`SET application_name='gloa_lock_holder'; BEGIN; ${lock}; SELECT pg_sleep(3.5); COMMIT;`);
        await observe("SELECT EXISTS (SELECT FROM pg_stat_activity WHERE application_name='gloa_lock_holder' AND wait_event='PgSleep');");
        ok(sql(`UPDATE public.finance_sync_config SET enabled=true,
          first_cycle_sync=tstzrange(now()-interval '1 second',now()+interval '2 seconds'),
          first_cycle_verify=tstzrange(now()+interval '4 seconds',now()+interval '6 seconds'),
          first_cycle_sync_reservation=gen_random_uuid();`));
        const writer = asyncSql(`SET application_name='gloa_waiting_writer'; SET statement_timeout='8s'; SELECT public.finance_sync_record_v1('${job}','${job}','${source}');`);
        await observe("SELECT EXISTS (SELECT FROM pg_stat_activity WHERE application_name='gloa_waiting_writer' AND wait_event_type='Lock');");
        ok(await holder);
        const rejected = await writer;
        assert.notEqual(rejected.status,0);
        assert.match(rejected.stderr,/finance_cycle_write_closed/);
        assert.equal(ok(sql('SELECT count(*) FROM public.synthetic_money_effects;')),'0');
        assert.equal(ok(sql('SELECT is_called FROM public.synthetic_writer_entries;')),source==='period'?'f':'t');
        assert.match(sql(`SELECT public.finance_sync_record_v1('${job}','${job}','${source}');`).stderr,/finance_cycle_write_closed/);
      }
      console.log('PASS: period lock rejected before writer; nested lock rolled back; expired replay rejected');
      return;
    }
    assert.equal(JSON.parse(ok(sql(request('incremental')))).state, 'closed');
    ok(sql(`UPDATE public.finance_sync_config SET enabled=true,
      first_cycle_sync=tstzrange(now()-interval '1 minute',now()+interval '1 minute'),
      first_cycle_verify=tstzrange(now()+interval '2 minutes',now()+interval '3 minutes');`));
    assert.equal(JSON.parse(ok(sql(request('daily')))).state, 'closed');
    assert.match(sql(`SELECT public.finance_sync_read_reserve_v2('${account}',80)`).stderr, /current_runtime_required/);
    const claims = await Promise.all(Array.from({length:4}, () => parallelSql(request('incremental'))));
    assert.equal(claims.filter(claim => claim.state==='closed').length,3);
    const first = claims.find(claim => claim.state==='admitted');
    assert.equal(first.granted,7);
    assert.ok(first.remainingMs>0);
    assert.equal(JSON.parse(ok(sql(request('incremental')))).state, 'closed');
    ok(sql(`INSERT INTO public.finance_sync_sources VALUES ('${account}','october','2026-10-30'),('${account}','november','2026-11-15');`));
    assert.match(sql(`SELECT public.finance_sync_record_v1('${job}','${job}','october');`).stderr,/outside_november/);
    assert.equal(JSON.parse(ok(sql(`SELECT public.finance_sync_record_v1('${job}','${job}','november');`))).result,'recorded');
    ok(sql(`UPDATE public.finance_sync_config SET
      first_cycle_sync=tstzrange(now()-interval '3 minutes',now()-interval '2 minutes'),
      first_cycle_verify=tstzrange(now()-interval '1 minute',now()+interval '1 minute');`));
    assert.match(sql(`SELECT public.finance_sync_record_v1('${job}','${job}','fake');`).stderr,/write_closed/);
    assert.equal(JSON.parse(ok(sql(request('daily')))).state,'closed');
    ok(sql(`UPDATE public.finance_sync_read_usage SET actual=1,scan_mode='incremental',job_reads=jsonb_build_object('${job}',1) WHERE id='${first.id}';`));
    assert.equal(JSON.parse(ok(sql(request('daily')))).granted,7);
    assert.equal(JSON.parse(ok(sql(request('daily')))).state,'closed');
    ok(sql(`UPDATE public.finance_sync_config SET first_cycle_verify=tstzrange(now()-interval '1 minute',now()-interval '1 second');`));
    assert.equal(JSON.parse(ok(sql(request('incremental')))).state,'closed');
    assert.equal(JSON.parse(ok(sql(request('daily')))).state,'closed');
    assert.equal(ok(sql('SELECT count(*) FROM public.finance_sync_read_usage;')),'2');
    console.log('PASS: disabled, window, legacy denial, concurrent claim, replay, failed sync, database write expiry, and two capped reservations');
  } finally {
    if (server?.pid && server.exitCode===null) run('pg_ctl',['stop','-D',dir,'-m','fast','-w']);
    if (log!==undefined) fs.closeSync(log);
  }
})().catch(error => { console.error(error); process.exitCode=1; });
