import {test,mock,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const pg=new PGlite();let tail=Promise.resolve();
async function lock(){const prior=tail;let done;tail=new Promise(r=>done=r);await prior;return done;}
async function query(sql,args){if(args?.length)return pg.query(sql,args);return (await pg.exec(sql)).at(-1)||{rows:[]};}
class Pool{on(){}async query(sql,args){const release=await lock();try{return await query(sql,args);}finally{release();}}async connect(){const release=await lock();return {query,release};}}
mock.module('pg',{defaultExport:{Pool}});process.env.DATABASE_URL='postgres://isolated-tour-test';
const db=await import('../db.js');after(()=>pg.close());
const owner=crypto.randomUUID(),stranger=crypto.randomUUID(),groupId=crypto.randomUUID();
test('fixed tour entrance keeps one code across independent sessions and survives recovery',async()=>{
 await db.runMigrations();
 await db.dbUpsertUserByGoogleSub({id:owner,googleSub:'tour-owner',email:'owner@example.invalid'});
 await db.dbUpsertUserByGoogleSub({id:stranger,googleSub:'tour-stranger',email:'stranger@example.invalid'});
 await db.dbCreateTourGroup({id:groupId,userId:owner,name:'五日旅行',code:'abcdefgh'});
 assert.equal((await db.dbGetOpenTourGroups())[0].code,'abcdefgh');
 assert.equal(await db.dbGetTourGroup(groupId,stranger),null);
 const firstId=crypto.randomUUID();
 await db.dbCreateTourSession({id:firstId,userId:owner,groupId,joinCode:'room01',name:'第一天上午'});
 await assert.rejects(db.dbCreateTourSession({id:crypto.randomUUID(),userId:owner,groupId,joinCode:'room02',name:'重複開場'}),/tour_session_active/);
 await assert.rejects(db.dbCreateTourSession({id:crypto.randomUUID(),userId:stranger,groupId,joinCode:'room03',name:'越權'}),/tour_not_found/);
 assert.equal((await db.dbGetTourGroupsByUser(owner))[0].active_session_id,firstId);
 assert.equal((await db.dbRecoverSessions()).some(row=>row.id===firstId),true);
 await db.dbMarkSessionEnded(firstId);
 assert.equal((await db.dbGetTourGroupsByUser(owner))[0].active_session_id,null);
 const secondId=crypto.randomUUID();
 await db.dbCreateTourSession({id:secondId,userId:owner,groupId,joinCode:'room04',name:'第二天下午'});
 const rooms=(await pg.query('SELECT id,name,tour_group_id FROM sessions WHERE tour_group_id=$1 ORDER BY created_at',[groupId])).rows;
 assert.equal(rooms.length,2);assert.deepEqual(new Set(rooms.map(row=>row.tour_group_id)),new Set([groupId]));
 assert.equal((await db.dbGetTourGroupsByUser(owner))[0].code,'abcdefgh');
 await assert.rejects(db.dbCloseTourGroup(groupId,owner),/tour_session_active/);
 await db.dbMarkSessionEnded(secondId);
 assert.equal(await db.dbRotateTourGroup(groupId,stranger,'newcode1'),null);
 await db.dbRotateTourGroup(groupId,owner,'newcode2');
 assert.equal((await db.dbGetTourGroupsForRouting())[0].code,'newcode2');
 await db.dbCloseTourGroup(groupId,owner);
 assert.equal((await db.dbGetOpenTourGroups()).length,0);
 assert.equal((await db.dbGetTourGroupsForRouting())[0].status,'closed');
 assert.equal((await pg.query('SELECT count(*)::int AS count FROM sessions WHERE tour_group_id=$1',[groupId])).rows[0].count,2);
});
