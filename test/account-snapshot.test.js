"use strict";
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-account-save-'));
process.env.TYPELESS_DATA_DIR=root;
process.env.TYPELESS_USER_DATA_DIR=path.join(root,'live');
const C=require('../lib/common');
after(()=>fs.rmSync(root,{recursive:true,force:true}));
function login(uid,marker=uid){
  fs.mkdirSync(C.USERDATA_DIR,{recursive:true});
  fs.writeFileSync(path.join(C.USERDATA_DIR,'app-storage.json'),JSON.stringify({userData:{user_id:uid}}));
  fs.writeFileSync(path.join(C.USERDATA_DIR,'user-data.json'),marker);
}
beforeEach(()=>{
  for(const name of fs.readdirSync(root)) fs.rmSync(path.join(root,name),{recursive:true,force:true});
  login('a','old'); C.saveAccountWithSnapshot([{user_id:'a',token:'old'}],'a');
});
test('保存账号文件失败会还原旧快照,两份数据不会一新一旧',()=>{
  login('a','new');
  const rename=fs.renameSync;
  fs.renameSync=(src,dst)=>{if(dst===C.ACCOUNTS_FILE)throw Error('injected disk failure');return rename(src,dst);};
  try{assert.throws(()=>C.saveAccountWithSnapshot([{user_id:'a',token:'new'}],'a'),/disk failure/);}
  finally{fs.renameSync=rename;}
  assert.equal(C.readAccounts()[0].token,'old');
  assert.equal(fs.readFileSync(path.join(C.PROFILES_DIR,'a/user-data.json'),'utf8'),'old');
  assert.ok(!fs.readdirSync(root).some(n=>n.startsWith('.account-save-')));
});
test('当前登录另一个账号时无法覆盖目标快照,损坏快照也不能覆盖当前登录',()=>{
  login('b');
  assert.throws(()=>C.saveAccountWithSnapshot([{user_id:'a',token:'new'}],'a'),/不匹配/);
  assert.equal(C.readAccounts()[0].token,'old');
  fs.writeFileSync(path.join(C.PROFILES_DIR,'a/app-storage.json'),'{}');
  assert.equal(C.hasSnapshot('a'),false);
  assert.throws(()=>C.restoreSnapshot('a'),/不匹配/);
  assert.equal(C.readCurrentLogin().user_id,'b');
});
test('恢复快照不会混入另一账号的可选文件,切换前备份能逐字还原',()=>{
  login('b');fs.writeFileSync(path.join(C.USERDATA_DIR,'app-onboarding.json'),'b-onboarding');
  const backup=C.backupCurrentLogin(), before=C.readLoginFiles();
  C.restoreSnapshot('a');
  assert.equal(C.readCurrentLogin().user_id,'a');
  assert.equal(fs.existsSync(path.join(C.USERDATA_DIR,'app-onboarding.json')),false);
  C.restoreLoginFiles(C.readLoginFiles(backup));
  assert.deepEqual(C.readLoginFiles(),before);
  for(const f of fs.readdirSync(backup))assert.equal(fs.statSync(path.join(backup,f)).mode&0o777,0o600);
});
