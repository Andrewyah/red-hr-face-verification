import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
test('local PostgreSQL contract: release gate, privileges, one-use jobs, enrollment revoke and session binding',async()=>{
 const db=new PGlite();
 try{
  await db.exec(await read('tests/face-login-bootstrap.sql'));
  const enrollment=await read('integration/hr-face-enrollment.sql');
  await db.exec(enrollment.slice(0,enrollment.indexOf('create table hr_face_private.capture_jobs')));
  await db.exec(await read('integration/hr-face-login.sql'));
  await db.exec(await read('tests/face-login-db.sql'));
  assert.equal((await db.query('select count(*)::int as n from hr_face_private.login_policy')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int as n from auth.users')).rows[0].n,0);
 }finally{await db.close();}
});
