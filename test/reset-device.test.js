'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'tt-reset-flow-'));
process.env.TYPELESS_DATA_DIR=root;
process.env.TYPELESS_USER_DATA_DIR=path.join(root,'live');
const paths=require('../lib/paths');
after(()=>fs.rmSync(root,{recursive:true,force:true}));
function fixture({keychainError,fileError,execute}={}){
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
        execFile:(cmd,args,options,cb)=>{
          if(typeof options==='function'){cb=options;options={};}
          if(execute)return execute(cmd,args,options,cb);
          cb(args[0]==='-f'?Object.assign(Error('no app'),{code:1}):null,'');
        },
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

test('进程探测超时不能当作退出成功，登录文件必须保持原样',async()=>{
  const f=fixture({execute:(cmd,_args,options,cb)=>{
    assert.ok(options.timeout>0); assert.equal(options.killSignal,'SIGKILL');
    cb(cmd==='pgrep'?Object.assign(Error('probe timeout'),{killed:true}):null,'');
  }});
  await assert.rejects(f.C.resetDevice(),/probe timeout/);
  assert.equal(f.C.readCurrentLogin().user_id,'a');
  assert.equal(fs.readFileSync(path.join(paths.USERDATA_DIR,'user-data.json'),'utf8'),'synthetic');
  assert.equal(f.starts(),0);
});

test('强制退出失败或进程仍存活时，不能继续修改登录文件',async()=>{
  for(const denied of [true,false]){
    let forced=false;
    const f=fixture({execute:(cmd,_args,_options,cb)=>{
      if(cmd==='pkill')forced=true;
      cb(cmd==='pkill'&&denied?Object.assign(Error('stop denied'),{code:2}):null,'');
    }});
    await assert.rejects(f.C.resetDevice(),denied?/stop denied/:/尚未退出/);
    assert.equal(forced,true);
    assert.equal(f.C.readCurrentLogin().user_id,'a');
  }
});

test('强制退出后确认进程消失才报告成功',async()=>{
  let forced=false;
  const f=fixture({execute:(cmd,_args,_options,cb)=>{
    if(cmd==='pkill')forced=true;
    cb(cmd==='pgrep'&&forced?Object.assign(Error('no app'),{code:1}):null,'');
  }});
  await f.C.killTypeless();
  assert.equal(forced,true);
});
