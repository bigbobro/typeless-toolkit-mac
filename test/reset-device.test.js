'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'tt-reset-flow-'));
process.env.TYPELESS_DATA_DIR=root;
process.env.TYPELESS_USER_DATA_DIR=path.join(root,'live');
const paths=require('../lib/paths');
after(()=>fs.rmSync(root,{recursive:true,force:true}));
function fixture({keychainError,fileError}={}){
  fs.mkdirSync(paths.USERDATA_DIR,{recursive:true});
  fs.writeFileSync(path.join(paths.USERDATA_DIR,'app-storage.json'),JSON.stringify({userData:{user_id:'a'}}));
  fs.writeFileSync(path.join(paths.USERDATA_DIR,'user-data.json'),'synthetic');
  const mod={exports:{}};let starts=0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/common.js'),'utf8'),{
    module:mod,console,Buffer,process,setTimeout:cb=>queueMicrotask(cb),
    require:name=>{
      if(name==='./paths')return {...paths,DEVICE_CACHE_PATHS:[],TYPELESS_BIN:'/fixture/Typeless'};
      if(name==='fs')return {...fs,unlinkSync:p=>{if(fileError&&p.endsWith('user-data.json'))throw fileError;return fs.unlinkSync(p);}};
      if(name==='child_process')return {
        execFile:(_cmd,args,cb)=>cb(args[0]==='-f'?Error('no app'):null,''),
        execFileSync:()=>{if(keychainError)throw keychainError;return '';},
        spawn:()=>{starts++;return {unref(){}};},
      };
      return require(name.startsWith('./')?'../lib/'+name.slice(2):name);
    },
  });
  return {C:mod.exports,starts:()=>starts};
}
test('设备清理权限错误不能被吞掉并宣告成功,失败后仍重新启动应用',async()=>{
  const f=fixture({fileError:Object.assign(Error('permission denied'),{code:'EACCES'})});
  await assert.rejects(f.C.resetDevice(),/permission denied/);
  assert.equal(f.starts(),1);
});
test('钥匙串删除失败必须中止后续登录文件清理',async()=>{
  const f=fixture({keychainError:Object.assign(Error('keychain denied'),{status:1})});
  await assert.rejects(f.C.resetDevice(),/keychain denied/);
  assert.equal(f.C.readCurrentLogin().user_id,'a');
  assert.equal(f.starts(),1);
});
test('设备凭据本来不存在时允许清理,完成后没有本地登录',async()=>{
  const f=fixture({keychainError:Object.assign(Error('item not found'),{status:44})});
  await f.C.resetDevice();assert.equal(f.C.readCurrentLogin(),null);assert.equal(f.starts(),1);
});
