import fs from 'node:fs/promises';
import path from 'node:path';
import {planFinanceReconciliation} from '../lib/financeReconciliation.ts';

// Explicit files only. No environment loading, network clients or SQL execution.
const [inputPath,outputPath,...extra]=process.argv.slice(2);
try {
 if (!inputPath || !outputPath || extra.length || ![inputPath,outputPath].every(p=>p.endsWith('.json')) || path.resolve(inputPath)===path.resolve(outputPath)) throw Error('arguments');
 const input=JSON.parse(await fs.readFile(inputPath,'utf8'));
 const plan=planFinanceReconciliation(input);
 await fs.writeFile(outputPath,JSON.stringify({mode:'DRY_RUN_ONLY',readyForDatabaseExecution:false,...plan},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({status:plan.blockers.length?'BLOCKED':'REVIEW_REQUIRED',entries:plan.entries.length,blockers:plan.blockers.length,excluded:plan.excluded.length}));
 process.exitCode=plan.blockers.length?2:0;
} catch {
 // Do not print arbitrary export contents or raw filesystem/provider exceptions.
 console.error('Dry-run fehlgeschlagen. Zwei unterschiedliche JSON-Pfade, gültige Belege und eine noch nicht vorhandene Ausgabedatei erforderlich.');
 process.exitCode=1;
}
