import 'dotenv/config';
import {runMigrations,pool,dbConfirmOrder,dbAdjustCredits,dbReconcileAccounts} from '../db.js';
const [command,...args]=process.argv.slice(2);
const flag=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
try{
 if(!['confirm','adjust','reconcile'].includes(command))throw Error('用法：confirm ORDER --operator NAME --reference BANK_REF | adjust USER AMOUNT --id UNIQUE_ID --operator NAME --reason REASON | reconcile');
 await runMigrations();
 let result;
 if(command==='confirm')result=await dbConfirmOrder(args[0],flag('operator'),flag('reference'));
 if(command==='adjust')result=await dbAdjustCredits(args[0],Number(args[1]),flag('id'),flag('operator'),flag('reason'));
 if(command==='reconcile'){result=await dbReconcileAccounts();if(result.some(x=>!x.matches))process.exitCode=2;}
 console.log(JSON.stringify(result,null,2));
}catch(error){console.error(error.message);process.exitCode=1;}finally{await pool?.end();}
