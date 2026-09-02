// Typeless 多账号管理器 —— 页面脚本。由 manager.html 以 <script src> 引入;
// SESSION_SECRET 由 manager.html 里的内联脚本先行声明(同为经典脚本,顶层 const 跨脚本可见)。

const api = (p, opt={}) => {
  const headers={
    'x-typeless-session':SESSION_SECRET,
    ...(opt.body!==undefined?{'Content-Type':'application/json'}:{}),
    ...(opt.headers||{}),
  };
  return fetch(p,{...opt,headers}).then(r=>r.json());
};
let ACCOUNTS = [], CUR_ID = null, curDetail = null, curWords = [], dictFilter = 'all', dictError = null;
let CONNECTION_STATE = 'checking', CONNECTION_BUSY = false, CURRENT_DETECTING = false;

function setConnectionUi(state,label){
  CONNECTION_STATE=state;
  const el=document.getElementById('curLink');
  const btn=document.getElementById('launchBtn');
  el.className='chip';
  btn.className='btn primary';
  el.disabled=state==='checking';
  if(state==='checking'){
    el.classList.add('neutral'); el.textContent=CONNECTION_BUSY?'正在连接…':'正在检查…';
    el.dataset.tip='正在检查 Typeless 管理连接';
    btn.textContent=CONNECTION_BUSY?'↻ 正在连接…':'⏻ 检查中…'; btn.disabled=true;
    btn.dataset.tip='正在检查管理连接状态';
  }else if(state==='disconnected'){
    el.classList.add('waiting'); el.textContent='管理连接未开启';
    el.dataset.tip='重新检查 Typeless 管理连接状态';
    btn.textContent='⏻ 连接 Typeless'; btn.disabled=false;
    btn.dataset.tip='启动或重启 Typeless 一次，开启识别当前账号所需的管理连接';
  }else if(state==='connected'){
    el.textContent=label?('当前: '+label):'管理连接已建立';
    el.dataset.tip='重新检测当前 Typeless 登录账号并在下方高亮';
    btn.classList.add('connected'); btn.textContent='✓ 已连接'; btn.disabled=true;
    btn.dataset.tip='Typeless 管理连接已建立';
  }else{
    el.classList.add('neutral'); el.textContent='连接状态异常';
    el.dataset.tip='重新检查 Typeless 管理连接状态';
    btn.textContent='↻ 重试连接'; btn.disabled=false;
    btn.dataset.tip='重新启动 Typeless 管理连接';
  }
}

// 单槽提示条。两条约束:
//  ① 每条自己管自己的清除定时器 —— 否则上一条的定时器会提前掐掉刚显示的这一条
//     (切号失败 1 秒后再弹一条,新的那条只剩 0.8 秒就消失了)。
//  ② 错误提示在展示期内不被普通提示顶掉 —— 操作为什么失败,比紧随其后的状态播报重要。
//     切号/重置/打补丁失败后都会接着跑 detectCurrent(),它的连接状态提示曾经把失败原因盖掉。
//     新的错误提示仍可覆盖旧的错误提示。
const TOAST_MS=1800;
let _toastT=null, _toastKind='', _toastUntil=0;
function toast(m,kind){
  const now=Date.now();
  if(_toastKind==='err' && kind!=='err' && now<_toastUntil) return;
  clearTimeout(_toastT);
  const t=document.getElementById('toast');
  t.textContent=m; t.className='toast on'+(kind?' '+kind:'');
  _toastKind=kind||''; _toastUntil=now+TOAST_MS;
  _toastT=setTimeout(()=>{ t.className='toast'; _toastKind=''; },TOAST_MS);
}
function openModal(id){ document.getElementById(id).classList.add('on'); }
function closeModal(id){ document.getElementById(id).classList.remove('on'); }
// Esc 关闭当前打开的弹窗(不改变原有点击遮罩关闭的行为)
document.addEventListener('keydown', e=>{
  if(e.key!=='Escape') return;
  const open=document.querySelector('.mask.on');
  if(!open) return;
  // 确认弹窗有一个待兑现的 Promise,Esc 必须等价于点「取消」,不能只隐藏不 resolve
  if(open.id==='confirmMask'){ document.getElementById('confirmCancelBtn').click(); return; }
  closeModal(open.id);
});
// 通用确认弹窗(替代原生 confirm),保留原文案不变,只换外壳
function confirmModal(msg, opts={}){
  return new Promise(resolve=>{
    document.getElementById('confirmTitle').textContent = opts.title || '确认';
    document.getElementById('confirmMsg').textContent = msg;
    const okBtn=document.getElementById('confirmOkBtn');
    okBtn.className='btn small '+(opts.danger?'danger':'primary');
    okBtn.textContent = opts.okText || '确认';
    document.getElementById('confirmCancelBtn').textContent = opts.cancelText || '取消';
    openModal('confirmMask');
    const cleanup=(v)=>{ closeModal('confirmMask'); okBtn.onclick=null; cancelBtn.onclick=null; resolve(v); };
    const cancelBtn=document.getElementById('confirmCancelBtn');
    okBtn.onclick=()=>cleanup(true);
    cancelBtn.onclick=()=>cleanup(false);
  });
}
// 高风险异步操作(切号/重置设备/打补丁/同步)防重入:同一时刻只允许一个在跑
let BUSY=false;
function setBusy(v){
  BUSY=v;
  ['btnSyncAll','btnResetDevice','btnPatchPaywall','btnSyncOne'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.disabled=v;
  });
  document.querySelectorAll('.cbtn:not(.off)').forEach(b=>{ b.disabled=v; });
}
function relTime(iso){
  if(!iso) return '';
  const ms=Date.now()-new Date(iso).getTime();
  const day=Math.floor(ms/86400000);
  if(day<=0) return '今天';
  if(day===1) return '1 天前';
  if(day<30) return day+' 天前';
  const mon=Math.floor(day/30);
  if(mon<12) return mon+' 个月前';
  return Math.floor(mon/12)+' 年前';
}
function fmtTime(s){
  if(!s) return '';
  try { return new Date(s).toLocaleString('zh-CN', { hour12:false }); }
  catch(e){ return s; }
}
function renderBackupStatus(d){
  const badge=document.getElementById('backupBadge');
  const text=document.getElementById('backupText');
  const meta=document.getElementById('backupMeta');
  badge.className='backup-badge';
  if(!d || d.status==='no_data'){
    badge.textContent='暂无数据';
    text.textContent='还没有账号/profile/主词库需要备份';
    meta.textContent='';
    return;
  }
  if(d.backed_up){
    badge.textContent='已备份';
    badge.classList.add('ok');
    text.textContent='本地运行数据已有当前备份';
  }else{
    badge.textContent='未备份';
    badge.classList.add('err');
    text.textContent='账号、登录态或主词库有变更,建议立即备份';
  }
  const latest=d.latest_backup ? `最近备份 ${fmtTime(d.latest_backup.mtime)}` : '没有备份记录';
  const changed=d.latest_data_mtime ? `数据更新 ${fmtTime(d.latest_data_mtime)}` : '';
  meta.textContent=[latest, changed].filter(Boolean).join(' · ');
}
async function loadBackupStatus(){
  try{
    const r=await api('/api/backup-status');
    if(r.status==='OK') renderBackupStatus(r.data);
  }catch(e){}
}
async function backupNow(){
  toast('备份中…');
  const r=await api('/api/backup-runtime',{method:'POST'});
  if(r.status==='OK'){
    renderBackupStatus(r.data);
    toast(r.msg||'已备份','ok');
  }else{
    toast(r.msg||'备份失败','err');
  }
}
async function exportBackup(){
  const ok=await confirmModal('导出的备份包包含 Typeless 登录信息、账号 token 和 profile 快照。\n\n不要随意分享给他人。确认导出吗?',{danger:true,okText:'确认导出'});
  if(!ok) return;
  try{
    const res=await fetch('/api/backup-export',{headers:{'x-typeless-session':SESSION_SECRET}});
    if(!res.ok) throw new Error('导出失败');
    const blob=await res.blob();
    const cd=res.headers.get('Content-Disposition')||'';
    const filename=(cd.match(/filename="([^"]+)"/)||[])[1]||'typeless-toolkit-backup.json';
    const url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast('备份包已导出','ok');
    loadBackupStatus();
  }catch(e){ toast('导出失败','err'); }
}
function pickBackupFile(){
  const input=document.getElementById('backupFile');
  input.value='';
  input.click();
}
async function restoreBackupFile(input){
  const file=input.files&&input.files[0];
  if(!file) return;
  const ok=await confirmModal('导入备份会覆盖当前管理器里的账号、profile 快照和主词库。\n\n备份包可能包含 Typeless 登录信息和账号 token,只导入你信任的备份包。恢复前会先自动备份当前数据。继续吗?',{danger:true,okText:'确认导入'});
  if(!ok) return;
  try{
    toast('恢复中…');
    const r=await api('/api/backup-restore',{method:'POST',body:file});
    if(r.status==='OK'){
      renderBackupStatus(r.data);
      toast('备份已恢复','ok');
      await loadAccounts();
      detectCurrent();
    }else{
      toast(r.msg||'恢复失败','err');
    }
  }catch(e){
    toast('恢复失败:备份包格式不正确','err');
  }
}

async function launch(){
  if(CONNECTION_BUSY) return;
  CONNECTION_BUSY=true;
  setConnectionUi('checking');
  try{
    const r=await api('/api/launch',{method:'POST'});
    if(r.status!=='OK') throw new Error(r.msg||'管理连接启动失败');
    const current=await detectCurrent(true);
    if(current?.state==='connected'){
      toast(current.account_detected?'Typeless 已连接，当前账号已识别':'Typeless 管理连接已建立','ok');
    }else{
      setConnectionUi('disconnected');
      toast('Typeless 已启动，但管理连接尚未建立','err');
    }
  }catch(e){
    setConnectionUi('disconnected');
    toast('连接失败: '+(e.message||'未知错误'),'err');
  }finally{
    CONNECTION_BUSY=false;
    if(CONNECTION_STATE==='checking') setConnectionUi('error');
  }
}
async function loadAccounts(){
  const g=document.getElementById('grid'); g.innerHTML='<div class="empty">加载中…</div>';
  const r=await api('/api/accounts');
  if(r.status!=='OK'){ g.innerHTML='<div class="empty">'+esc(r.msg)+'</div>'; return; }
  ACCOUNTS=r.data||[];
  render();
  loadBackupStatus();
}
function pct(v,l){ return l? Math.min(100, Math.round(v/l*100)):0; }
function render(){
  updateQuotaBanner();
  const g=document.getElementById('grid');
  if(!ACCOUNTS.length){ g.innerHTML='<div class="empty">还没有账号。点「添加当前账号」开始（先在 Typeless 登录该号）。</div>'; return; }
  g.innerHTML=ACCOUNTS.map(a=>{
    const live=a.live||{};
    const u=live.usage||{};
    const ok=u.week_word_usage_value!=null; // liveStatus 失败时 usage 为空,显示 — 而非误导的 0
    const used=ok?u.week_word_usage_value:0, lim=u.week_word_usage_limit||8000;
    const p=pct(used,lim); const over=ok&&used>lim;
    const valid=live.token_valid!==false;
    const cur=a.user_id===CUR_ID;
    let texp='';
    if(a.token_days_left!=null){
      const cls = a.token_days_left<=0 ? 'bad' : (a.token_days_left<30 ? 'warn' : '');
      const txt = a.token_days_left<=0 ? 'token 已过期' : `token 剩余 ${a.token_days_left} 天`;
      texp = `<div class="texp ${cls}" data-tip="token 过期日:${a.token_expires_at?esc(a.token_expires_at.slice(0,10)):''}">${txt}</div>`;
    }
    const snapTxt = a.has_snapshot ? ('快照已存'+(a.snapshot_mtime?' · '+relTime(a.snapshot_mtime):'')) : '未存快照';
    return `<div class="card ${cur?'on':''}" data-account-id="${esc(a.user_id)}">
      <div class="chead">
        <div class="cid">
          <div class="nrow"><span class="nick">${esc(a.nickname)}</span>${cur?'<span class="curmark">当前</span>':''}</div>
          <div class="email">${esc(a.email||'')}</div>
          ${texp}
        </div>
        <span class="flag ${valid?'':'bad'}">${valid?esc(a.role||'未知'):'token失效'}</span>
      </div>
      <div class="cbody">
        <div class="qrow"><span>本周额度</span><b>${ok?used.toLocaleString():'—'} / ${lim.toLocaleString()}</b></div>
        <div class="qtrack ${over?'over':(p>80?'warn':'')}"><i style="width:${ok?(over?100:p):0}%"></i></div>
        <div class="qrow"><span>剩余字数</span><b>${ok?(lim-used).toLocaleString():'—'}</b></div>
        <div class="mini">
          <div class="m"><div class="k">词库词条</div><div class="v">${live.dict_count??'-'}</div></div>
          <div class="m"><div class="k">个性化</div><div class="v">${Math.round((live.personal?.total_learning_ratio||0)*100)}%</div></div>
          <div class="m"><div class="k">总字数</div><div class="v">${(u.total_words||0).toLocaleString()}</div></div>
        </div>
        <div class="cfoot">
          <span class="snap">${snapTxt}</span>
          ${a.has_snapshot
            ? `<button class="cbtn" data-action="switch-account" data-account-id="${esc(a.user_id)}" data-tr data-tip="还原该账号登录态快照并重启 Typeless，随后自动同步该账号词库">切换到此号</button>`
            : `<span class="cbtn off" data-tr data-tip="该账号还没有快照，先在 Typeless 登录该号后点「更新快照」">切换到此号</span>`}
        </div>
        <div class="copen"><span>查看词库 / 用量 / 个性化</span><span class="arw">›</span></div>
      </div>
    </div>`;
  }).join('');
}
function esc(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

document.getElementById('grid').addEventListener('click',e=>{
  const switchBtn=e.target.closest('[data-action="switch-account"]');
  if(switchBtn){ e.stopPropagation(); switchTo(switchBtn.dataset.accountId); return; }
  const card=e.target.closest('.card[data-account-id]');
  if(card) openDetail(card.dataset.accountId);
});

// 词库接口失败必须显示成失败,不能显示成「空词库」。后端 assertApiOk 已经把 curl
// 层的失败转成 status:'FAIL'+msg,前端若直接取 data 就等于在最后一米把这道保护
// 还原掉:token 失效 / 断网时用户看到的是「0 词」,像是自己从没加过词。
async function loadWords(uid){
  const r=await api('/api/accounts/'+encodeURIComponent(uid)+'/dictionary');
  if(r.status!=='OK'){ dictError=r.msg||'未知原因'; toast('词库读取失败: '+dictError,'err'); return false; }
  curWords=r.data?.words||[]; dictError=null; return true;
}
async function openDetail(id){
  const a=ACCOUNTS.find(x=>x.user_id===id); if(!a) return;
  curDetail=a;
  document.getElementById('dTitle').textContent=a.nickname+' · '+(a.email||'');
  openModal('detailMask');
  selTab(document.querySelector('.tab'),'dict');
  curWords=[]; dictError=null;   // 先清掉上一个账号的词:读失败时不能把 A 的词挂在 B 名下
  await loadWords(id);
  dictFilter='all';
  document.querySelectorAll('.wf').forEach((b,i)=>b.classList.toggle('on', i===0));
  document.getElementById('dictSearch').value=''; renderDict();
  renderUsage(a); renderPersonal(a);
}
function selTab(el,tab){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on')); el.classList.add('on');
  ['dict','usage','personal'].forEach(t=>document.getElementById('tab-'+t).style.display = t===tab?'block':'none');
}
function setDictFilter(el,f){
  dictFilter=f;
  document.querySelectorAll('.wf').forEach(b=>b.classList.remove('on'));
  el.classList.add('on');
  renderDict();
}
function renderDict(){
  const q=(document.getElementById('dictSearch').value||'').trim().toLowerCase();
  let ws=curWords.filter(w=>!q||(w.term||'').toLowerCase().includes(q));
  if(dictFilter==='auto') ws=ws.filter(w=>w.auto);
  else if(dictFilter==='manual') ws=ws.filter(w=>!w.auto);
  const cnt=document.getElementById('wordCount');
  if(cnt) cnt.textContent = dictError ? '读取失败' : ws.length+' 词';
  document.getElementById('wordList').innerHTML = ws.length
    ? '<div class="wgrid">'+ws.map(w=>`<div class="wcell">
        <span class="wicon ${w.auto?'auto':''}" data-tip="${w.auto?'自动添加':'手动添加'}">${w.auto?'✦':'✎'}</span>
        <span class="wt" title="${esc(w.term)}">${esc(w.term)}</span>
        <span class="wdel" role="button" tabindex="0" data-action="delete-word" data-term="${esc(w.term)}" data-tr data-tip="从该账号词库删除此词">✕</span>
      </div>`).join('')+'</div>'
    : '<div class="empty" style="padding:20px">'+(dictError?'词库读取失败：'+esc(dictError):'无匹配词条')+'</div>';
}
document.getElementById('wordList').addEventListener('click',e=>{
  const btn=e.target.closest('[data-action="delete-word"]');
  if(btn) delWord(btn.dataset.term);
});
document.getElementById('wordList').addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ') return;
  const btn=e.target.closest('[data-action="delete-word"]');
  if(btn){ e.preventDefault(); delWord(btn.dataset.term); }
});
function renderUsage(a){
  const u=a.live?.usage||{};
  const ok=u.week_word_usage_value!=null;
  const used=ok?u.week_word_usage_value:0, lim=u.week_word_usage_limit||8000;
  const rem=lim-used, p=pct(used,lim), over=ok&&used>lim;
  const ringc=over?'var(--red)':(p>80?'var(--amber)':'var(--grn)');
  const secs=Math.round(u.total_audio_seconds||0);
  const mins=Math.round(secs/60);
  const saved=u.mins_saved||0;
  const wpm=u.avg_wpm||0;
  const spd=Math.min(100, Math.round(wpm/250*100));
  document.getElementById('tab-usage').innerHTML=`<div class="uwrap">
    <div class="uhero">
      <div class="uring" style="--p:${ok?(over?100:p):0};--ringc:${ringc}"><div class="uring-c"><b>${ok?p+'%':'—'}</b><span>本周已用</span></div></div>
      <div class="uhero-side">
        <div class="uline"><span class="mut">本周已用</span><b>${ok?used.toLocaleString():'—'} / ${lim.toLocaleString()} 字</b></div>
        <div class="uline"><span class="mut">剩余</span><b style="color:${over?'var(--red)':'var(--grn-d)'}">${ok?rem.toLocaleString():'—'} 字</b></div>
      </div>
    </div>
    <div class="ustats">
      <div class="ustat"><div class="uk">总听写字数</div><div class="uv">${(u.total_words||0).toLocaleString()}</div><div class="usub">累计</div></div>
      <div class="ustat"><div class="uk">录音总时长</div><div class="uv">${mins.toLocaleString()} <em>分钟</em></div><div class="usub">${secs.toLocaleString()} 秒</div></div>
      <div class="ustat"><div class="uk">平均语速</div><div class="uv">${wpm} <em>wpm</em></div><div class="uspeed"><i style="width:${spd}%"></i></div></div>
      <div class="ustat hl"><div class="uk">已节省</div><div class="uv">${(saved/60).toFixed(1)} <em>小时</em></div><div class="usub">约 ${Math.round(saved).toLocaleString()} 分钟</div></div>
    </div>
  </div>`;
}
function renderPersonal(a){
  const p=a.live?.personal||{}; const ratio=p.total_learning_ratio||0;
  document.getElementById('tab-personal').innerHTML=`<div style="text-align:center">
    <div class="ring" style="--p:${Math.round(ratio*100)}"><span>${Math.round(ratio*100)}%</span></div>
    <div style="color:var(--mut);font-size:12px">个性化学习进度</div>
    <div style="font-size:13px;margin-top:6px">${p.enabled?'已启用':'未启用'} · ${p.category_count??0} 个学习类别</div>
  </div>`;
}
async function addWord(){
  const t=document.getElementById('wordInput').value.trim(); if(!t||!curDetail) return;
  const r=await api('/api/accounts/'+encodeURIComponent(curDetail.user_id)+'/word',{method:'POST',body:JSON.stringify({term:t})});
  if(r.status==='OK'){ toast('已添加','ok'); document.getElementById('wordInput').value=''; await loadWords(curDetail.user_id); renderDict(); } else toast('添加失败: '+(r.msg||'未知原因'),'err');
}
function toggleBatchAdd(on){
  document.getElementById('wordAddRow').style.display = on?'none':'flex';
  document.getElementById('wordBatchRow').style.display = on?'block':'none';
  if(on) document.getElementById('wordBatchInput').value='';
}
async function addWordsBatch(){
  if(!curDetail) return;
  const terms=document.getElementById('wordBatchInput').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(!terms.length){ toast('请输入至少一个词','err'); return; }
  toast('批量添加中…');
  const r=await api('/api/accounts/'+encodeURIComponent(curDetail.user_id)+'/words',{method:'POST',body:JSON.stringify({terms})});
  if(r.status==='OK'){
    toast(`已提交 ${r.data.requested} 个,成功 ${r.data.imported} 个`,'ok');
    toggleBatchAdd(false);
    await loadWords(curDetail.user_id); renderDict();
  } else toast('批量添加失败: '+(r.msg||'未知原因'),'err');
}
async function delWord(term){
  if(!curDetail) return;
  const ok=await confirmModal('删除「'+term+'」?',{danger:true,okText:'删除'});
  if(!ok) return;
  const r=await api('/api/accounts/'+encodeURIComponent(curDetail.user_id)+'/word?term='+encodeURIComponent(term),{method:'DELETE'});
  if(r.status==='OK'){ toast('已删除','ok'); curWords=curWords.filter(w=>w.term!==term); renderDict(); } else toast('删除失败: '+(r.msg||'未知原因'),'err');
}
async function syncOne(){
  if(!curDetail||BUSY) return;
  setBusy(true); toast('同步中…');
  try{
    const r=await api('/api/accounts/'+encodeURIComponent(curDetail.user_id)+'/sync',{method:'POST'});
    if(r.status==='OK') toast(`同步完成:导出 ${r.data.exported} / 导入 ${r.data.imported} / 主库 ${r.data.master_count}`,'ok');
    else toast('失败: '+(r.msg||''),'err');
    await loadAccounts();
  } finally { setBusy(false); }
}
function syncRowHtml(item){
  if(item.error) return diagRow('bad', esc(item.nickname||item.user_id), esc(item.error), 'bad');
  return diagRow('ok', esc(item.nickname||item.user_id), `导出 ${item.exported} / 导入 ${item.imported} / 主库 ${item.master_count}`, '');
}
async function syncAll(){
  if(BUSY) return;
  setBusy(true);
  openModal('syncMask');
  const body=document.getElementById('syncBody');
  body.innerHTML='<div class="diag-prog"><div class="diag-prog-bar"><i id="syncBar"></i></div>'
    +'<div class="diag-prog-txt" id="syncTxt"><span class="spin" id="syncSpin"></span><span id="syncStep">同步中…</span><span class="cnt" id="syncCnt"></span></div></div>'
    +'<div id="syncRows"></div>';
  try{
    const r=await api('/api/sync-all',{method:'POST'});
    const list=r.status==='OK'?(r.data||[]):[];
    const bar=document.getElementById('syncBar'), stepEl=document.getElementById('syncStep'),
          cntEl=document.getElementById('syncCnt'), rowsEl=document.getElementById('syncRows'),
          txtEl=document.getElementById('syncTxt'), spin=document.getElementById('syncSpin');
    const N=list.length||1;
    for(let i=0;i<list.length;i++){
      stepEl.textContent='正在同步 '+(list[i].nickname||list[i].user_id)+'…';
      cntEl.textContent=(i+1)+' / '+N;
      rowsEl.insertAdjacentHTML('beforeend', syncRowHtml(list[i]));
      bar.style.width=Math.round((i+1)/N*100)+'%';
      await diagSleep(220);
    }
    spin.style.display='none'; txtEl.classList.add('done');
    stepEl.textContent = list.length ? '✓ 全部同步完成' : '没有账号可同步';
    cntEl.textContent=list.length+' / '+list.length;
    toast(`完成 ${list.length} 个账号`, list.some(x=>x.error)?'err':'ok');
    await loadAccounts();
  } finally { setBusy(false); }
}
// 切号 = 还原快照重启 Typeless + 紧接着同步该账号词库。
// 两个 API 分开调:切号是破坏性操作(杀进程、覆盖登录态文件),同步是纯增量网络操作,
// 同步失败不能让「号其实已经切好了」这个结论被一起否定,所以分别汇报。
async function switchTo(id){
  if(BUSY) return;
  const a=ACCOUNTS.find(x=>x.user_id===id); if(!a) return;
  const ok=await confirmModal('切换到「'+a.nickname+'」?将关闭并重启 Typeless,并自动同步该账号词库。',{danger:true,okText:'切换'});
  if(!ok) return;
  setBusy(true);
  try{
    toast('切换中…');
    const r=await api('/api/accounts/'+encodeURIComponent(id)+'/switch',{method:'POST'});
    if(r.status!=='OK'){
      toast(r.msg||'切换失败','err');
      await loadAccounts(); await detectCurrent();
      return;                       // 号没切成,不去同步一个并没有生效的账号
    }
    toast('已切换,正在同步词库…');
    // 同步走该账号已存的 token,不依赖 Typeless 起没起来,
    // 所以让它和「等 Typeless 重启完」的等待并行,不额外拖长切号耗时。
    const [sync]=await Promise.all([
      api('/api/accounts/'+encodeURIComponent(id)+'/sync',{method:'POST'})
        .catch(e=>({status:'FAIL',msg:e.message||'网络错误'})),
      diagSleep(6000),
    ]);
    if(sync.status==='OK'){
      toast(`已切换 · 词库同步完成:导出 ${sync.data.exported} / 导入 ${sync.data.imported} / 主库 ${sync.data.master_count}`,'ok');
    }else{
      toast('已切换,但词库同步失败:'+(sync.msg||'未知原因'),'err');
    }
    await loadAccounts(); await detectCurrent();
  } finally { setBusy(false); }
}
async function resetDevice(){
  if(BUSY) return;
  const ok=await confirmModal('解除设备限制?\n\n将重置设备 ID(删凭据+device.cache+user-data+清登录态),Typeless 重启到登录页,即可注册新账号。\n当前账号会被登出(若已存快照可随时切回)。',{danger:true,okText:'解除设备限制'});
  if(!ok) return;
  setBusy(true);
  try{
    toast('重置中…');
    const r=await api('/api/reset-device',{method:'POST'});
    toast(r.msg||'已重置', r.status==='OK'?'ok':'err');
    loadBackupStatus();
    await diagSleep(7000);
    await loadAccounts(); await detectCurrent();
  } finally { setBusy(false); }
}
// 解除升级/会员弹窗(等长字节补丁 app.asar + 应用完整性哈希)
async function patchPaywall(){
  if(BUSY) return;
  setBusy(true);
  try{
    // 先查状态:已打过就提示,不再动文件
    let st={};
    try{ st=await api('/api/paywall-status'); }catch(e){}
    if(st.data && st.data.patched){
      toast('已是无弹窗补丁版,无需重复操作');
      return;
    }
    const ok=await confirmModal('解除升级弹窗?\n\n将修改 app.asar 与 Info.plist 完整性记录(等长字节替换 gn(x)→(0,x),并重新签名 Typeless.app)。\n本次操作会创建绑定当前版本和哈希的事务备份;任一步失败只回滚本次备份并重新验证签名。\nTypeless 会先关闭,打完自动重启。\n注意:Typeless 自动更新会还原补丁,届时需重打。',{danger:true,okText:'解除弹窗提示'});
    if(!ok) return;
    toast('打补丁中…');
    const r=await api('/api/patch-paywall',{method:'POST'});
    if(r.status==='OK'){
      toast(r.data?.already?'已是补丁版,无需重打':'补丁完成,已重启 Typeless','ok');
    }else{
      toast(r.msg||'打补丁失败','err');
    }
    loadBackupStatus();
    await diagSleep(7000);
    detectCurrent();
  } finally { setBusy(false); }
}
async function importMaster(){
  if(!curDetail) return; toast('导入主词库中…');
  const r=await api('/api/accounts/'+encodeURIComponent(curDetail.user_id)+'/import-master',{method:'POST'});
  if(r.status==='OK') toast(`主词库 ${r.data.master} 条,新导入 ${r.data.imported} 条`,'ok');
  else toast('失败: '+(r.msg||''),'err');
  await loadAccounts();
}
function copyFrom(){
  if(!curDetail) return;
  const others=ACCOUNTS.filter(x=>x.user_id!==curDetail.user_id);
  if(!others.length){ toast('没有其他账号可复制','err'); return; }
  document.getElementById('copyTargetLabel').textContent='复制到「'+curDetail.nickname+'」,选择源账号';
  document.getElementById('copySrcSelect').innerHTML=others.map(x=>`<option value="${esc(x.user_id)}">${esc(x.nickname)}${x.email?' ('+esc(x.email)+')':''}</option>`).join('');
  openModal('copyMask');
}
async function confirmCopyFrom(){
  if(!curDetail) return;
  const srcId=document.getElementById('copySrcSelect').value;
  if(!srcId) return;
  closeModal('copyMask');
  toast('复制中…');
  const r=await api('/api/accounts/'+encodeURIComponent(curDetail.user_id)+'/copy-from/'+encodeURIComponent(srcId),{method:'POST'});
  if(r.status==='OK') toast(`源 ${r.data.src_count} 条,新导入 ${r.data.imported} 条`,'ok');
  else toast('失败: '+(r.msg||''),'err');
  await loadAccounts();
}
async function saveSnap(){
  if(!curDetail) return;
  const r=await api('/api/accounts/'+encodeURIComponent(curDetail.user_id)+'/snapshot',{method:'POST'});
  toast(r.msg||'已保存', r.status==='OK'?'ok':'err'); await loadAccounts(); loadBackupStatus();
}
async function rmAccount(){
  if(!curDetail) return;
  const ok=await confirmModal('从管理器移除「'+curDetail.nickname+'」?(不影响 Typeless)',{danger:true,okText:'移除'});
  if(!ok) return;
  api('/api/accounts/'+encodeURIComponent(curDetail.user_id),{method:'DELETE'}).then(r=>{
    if(r.status!=='OK'){ toast(r.msg||'移除失败','err'); return; }
    closeModal('detailMask');loadAccounts();loadBackupStatus();toast('已移除','ok');
  });
}

function addAccount(){ openModal('addMask'); document.getElementById('addStep1').style.display='block'; document.getElementById('addStep2').style.display='none'; }
async function doCapture(){
  const btn=document.getElementById('capBtn'); btn.disabled=true; btn.textContent='抓取中…(主窗口将重载)';
  const r=await api('/api/capture',{method:'POST'});
  btn.disabled=false; btn.textContent='抓取当前账号';
  if(r.status!=='OK'){ toast('抓取失败: '+(r.msg||''),'err'); return; }
  const d=r.data; window._cap=d;
  document.getElementById('addStep1').style.display='none';
  document.getElementById('addStep2').style.display='block';
  document.getElementById('addNick').value=d.nickname||d.email||'';
  document.getElementById('addEmail').value=d.email||'';
  document.getElementById('addMeta').value=(d.role||'')+' · '+d.user_id;
  const exist=ACCOUNTS.find(x=>x.user_id===d.user_id);
  document.getElementById('addExist').textContent=exist?'该账号已存在,保存将更新 token':'';
}
async function saveAccount(){
  const d=window._cap; if(!d) return;
  const r=await api('/api/accounts',{method:'POST',body:JSON.stringify({
    capture_id:d.capture_id,
    nickname:document.getElementById('addNick').value.trim(),
    email:document.getElementById('addEmail').value.trim()||d.email,
  })});
  if(r.status!=='OK'){ toast('保存失败: '+(r.msg||'未知原因'),'err'); return; }
  closeModal('addMask'); toast('已保存,正在迁移主词库到此号…');
  // 自动迁移:把主词库导入新账号
  const m=await api('/api/accounts/'+encodeURIComponent(d.user_id)+'/import-master',{method:'POST'});
  if(m.status==='OK') toast('添加完成,已导入 '+m.data.imported+' 个词','ok');
  await loadAccounts(); loadBackupStatus();
}

// ===== 注册新账号引导:轮询 /api/current 驱动三步状态 =====
// 状态映射: OK+已收录账号→步骤1(还没登出) / FAIL+connected→步骤2(登录页,等注册) / OK+未收录账号→步骤3(可抓取) / FAIL+disconnected→提示先连接
let REG_TIMER=null, REG_POLLING=false, REG_DETECTED=null;
function openRegGuide(){
  REG_DETECTED=null;
  openModal('regMask');
  regRender(1);
  regPoll();
  if(!REG_TIMER) REG_TIMER=setInterval(regPoll,4000);
}
function regRender(phase,info){
  info=info||{};
  const conn=document.getElementById('rgConn');
  if(info.disconnected){
    conn.style.display='flex';
    conn.innerHTML='<span>⚠ 管理连接未开启，无法自动检测 Typeless 登录状态</span>'
      +'<button class="btn small" data-tr data-tip="启动或重启 Typeless 一次，开启管理连接" onclick="launch()">⏻ 连接 Typeless</button>';
  }else{ conn.style.display='none'; conn.innerHTML=''; }
  for(let i=1;i<=3;i++){
    document.getElementById('rgStep'+i).className='rg-step'+(i<phase?' done':(i===phase?' on':''));
    document.getElementById('rgNum'+i).textContent=i<phase?'✓':String(i);
  }
  const h1=document.getElementById('rgHint1');
  if(info.knownLogin){ h1.style.display='block'; h1.textContent='当前登录的还是已收录账号「'+info.knownLogin+'」— 尚未登出。'; }
  else{ h1.style.display='none'; h1.textContent=''; }
  document.getElementById('rgWait').style.display=(phase===2&&!info.disconnected)?'flex':'none';
  const det=document.getElementById('rgDetected'), cap=document.getElementById('rgCapWrap');
  if(phase===3&&REG_DETECTED){
    det.innerHTML='✓ 检测到新账号 <b>'+esc(REG_DETECTED.email||REG_DETECTED.user_id)+'</b> 已登录。确认是刚注册的新账号后，点下方按钮加入管理器。';
    cap.style.display='flex';
  }else{
    det.textContent='检测到新账号登录后，这一步会自动亮起。';
    cap.style.display='none';
  }
}
async function regPoll(){
  const mask=document.getElementById('regMask');
  // 任何方式关闭弹窗(✕/遮罩/Esc)后,下一轮自清理定时器
  if(!mask.classList.contains('on')){ if(REG_TIMER){ clearInterval(REG_TIMER); REG_TIMER=null; } return; }
  if(REG_POLLING) return;
  REG_POLLING=true;
  try{
    const r=await api('/api/current');
    if(!mask.classList.contains('on')) return;
    if(r.status==='OK'&&r.data){
      const d=r.data;
      const known=ACCOUNTS.find(x=>x.user_id===d.user_id);
      if(known){ REG_DETECTED=null; regRender(1,{knownLogin:known.nickname||known.email||d.user_id}); }
      else{ REG_DETECTED=d; regRender(3); }
    }else{
      REG_DETECTED=null;
      if(r.data?.state==='connected') regRender(2);
      else regRender(1,{disconnected:true});
    }
  }catch(e){ /* 单次探测失败:保持当前显示,下一轮再试 */ }
  finally{ REG_POLLING=false; }
}
function regCapture(){
  if(REG_TIMER){ clearInterval(REG_TIMER); REG_TIMER=null; }
  closeModal('regMask');
  addAccount();   // 复用添加弹窗:抓取成功后自动进入保存表单(含自动导入主词库)
  doCapture();
}

// 当前账号本周额度用满时,顶部横幅主动引导注册新账号(每次会话可忽略)
let QUOTA_DISMISSED=false;
function updateQuotaBanner(){
  const b=document.getElementById('quotaBanner');
  const cur=CUR_ID?ACCOUNTS.find(x=>x.user_id===CUR_ID):null;
  const u=(cur&&cur.live&&cur.live.usage)||{};
  const lim=u.week_word_usage_limit||8000;
  const full=u.week_word_usage_value!=null&&u.week_word_usage_value>=lim;
  if(!cur||!full||QUOTA_DISMISSED){ b.style.display='none'; b.innerHTML=''; return; }
  b.style.display='flex';
  b.innerHTML='<span>⚠ 当前账号「'+esc(cur.nickname)+'」本周额度已用满（'+u.week_word_usage_value.toLocaleString()+' / '+lim.toLocaleString()+'）— 可注册一个新账号继续使用。</span>'
    +'<span style="display:flex;gap:10px;align-items:center;flex:none;">'
    +'<button class="btn small" data-tip="分步引导：登出 / 解除设备限制 → 注册并登录 → 自动检测并抓取" onclick="openRegGuide()">→ 注册新账号引导</button>'
    +'<span class="x" data-tip="本次会话不再提示" onclick="QUOTA_DISMISSED=true;updateQuotaBanner()">✕</span></span>';
}

async function openMaster(){
  const r=await api('/api/master');
  // 读失败必须直接返回:此前会照常开弹窗并把 textarea 清空,用户一点保存就把主词库写成空
  if(r.status!=='OK'){ toast('主词库读取失败: '+(r.msg||'未知原因'),'err'); return; }
  document.getElementById('masterArea').value=(r.data||[]).join('\n');
  document.getElementById('masterCnt').textContent=(r.data||[]).length+' 条';
  openModal('masterMask');
}
async function saveMaster(){
  const terms=document.getElementById('masterArea').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const r=await api('/api/master',{method:'POST',body:JSON.stringify({terms})});
  if(r.status==='OK'){ document.getElementById('masterArea').value=r.data.join('\n'); document.getElementById('masterCnt').textContent=r.data.length+' 条'; toast('已保存','ok'); loadBackupStatus(); }
  else toast('保存失败: '+(r.msg||'未知原因'),'err');
}

function openDiag(){ openModal('diagMask'); renderDiag(); }
const diagSleep=ms=>new Promise(r=>setTimeout(r,ms));
function diagRow(dot,k,v,vcls){ return `<div class="diag-row in"><span class="ddot ${dot}"></span><span class="dk">${k}</span><span class="dv ${vcls||''}">${v}</span></div>`; }
function paywallRowHtml(pw){
  const reverted = pw.exists && pw.has_backup && !pw.patched;
  let dot='neutral', txt='未打补丁', cls='mut';
  if(pw.error){ dot='warn'; txt=esc(pw.error); cls='warn'; }
  else if(reverted){ dot='warn'; txt='<span class="warn">已被 Typeless 更新还原，需重打</span>'; cls=''; }
  else if(pw.patched){ dot='ok'; txt='<b>已打补丁</b>'; cls=''; }
  return `<div class="diag-row in"><span class="ddot ${dot}"></span><span class="dk">去弹窗补丁</span><span class="dv ${cls}">${txt}</span></div>`;
}
let diagRunning=false;
async function renderDiag(){
  if(diagRunning) return;            // 防重复触发
  diagRunning=true;
  const STEP_MS=380;
  const el=document.getElementById('diagBody');
  el.innerHTML='<div class="diag-prog"><div class="diag-prog-bar"><i id="diagBar"></i></div>'
    +'<div class="diag-prog-txt" id="diagTxt"><span class="spin" id="diagSpin"></span><span id="diagStep">开始体检…</span><span class="cnt" id="diagCnt"></span></div></div>'
    +'<div id="diagRows"></div>';
  const bar=document.getElementById('diagBar'), stepEl=document.getElementById('diagStep'),
        cntEl=document.getElementById('diagCnt'), rowsEl=document.getElementById('diagRows'),
        txtEl=document.getElementById('diagTxt'), spin=document.getElementById('diagSpin');
  const r=await api('/api/diagnostics');
  if(r.status!=='OK'){ el.innerHTML='<div class="empty">'+esc(r.msg||'检查失败')+'</div>'; diagRunning=false; return; }
  const d=r.data, t=d.typeless;
  const cur=(CUR_ID && ACCOUNTS.length)?ACCOUNTS.find(x=>x.user_id===CUR_ID):null;
  const bk=d.data.backup||{};
  const steps=[
    {label:'检查 Typeless 应用', row:()=>diagRow(t.app_found?'ok':'bad','Typeless 应用', t.app_found?`<b>已找到</b> ${esc(t.app_path)}`:'未找到 — 请确认已安装 Typeless', t.app_found?'mut':'bad')},
    {label:'检查 app.asar', row:()=>diagRow(t.asar_found?'ok':'bad','app.asar', t.asar_found?'已找到':'未找到（去弹窗补丁不可用）', t.asar_found?'mut':'bad')},
    {label:'检查用户数据目录', row:()=>diagRow(t.user_data_found?'ok':'warn','用户数据目录', t.user_data_found?esc(t.user_data_dir):'未找到', t.user_data_found?'mut':'warn')},
    {label:'连接管理端口 '+d.cdp.port, row:()=>diagRow(d.cdp.reachable?'ok':'warn','管理端口 '+d.cdp.port, d.cdp.reachable?'<b>已连接</b>':'未开启 — 点「⏻ 连接 Typeless」', d.cdp.reachable?'':'warn')},
    {label:'确认当前登录账号', row:()=>diagRow(cur?'ok':'neutral','当前登录', cur?`<b>${esc(cur.nickname||cur.email||CUR_ID)}</b>`:(d.cdp.reachable?'管理连接已建立，尚未识别账号':'未检测（管理连接未开启）'), cur?'':'mut')},
    {label:'读取 app.asar，检查去弹窗补丁（较慢，请稍候）', slow:true, row:async()=>{ let pw={}; try{ const pr=await api('/api/paywall-status'); pw=pr.data||{}; }catch(e){ pw={error:'检查失败'}; } return paywallRowHtml(pw); }},
    {label:'确认代码目录', row:()=>diagRow('neutral','代码目录', esc(d.data.code_dir||''), 'mut')},
    {label:'检查稳定数据目录', row:()=>diagRow(d.data.writable?'ok':'bad','数据目录', `${esc(d.data.dir)}${d.data.writable?'':' <span class="bad">（不可写！）</span>'}`, d.data.writable?'mut':'')},
    {label:'检查旧数据迁移', row:()=>diagRow('ok','数据迁移', esc(d.data.migration?.status||'ready'), 'mut')},
    {label:'统计已收录账号', row:()=>diagRow('neutral','已收录账号', `<b>${d.data.accounts_count}</b> 个`, '')},
    {label:'检查运行数据备份', row:()=>diagRow(bk.backed_up?'ok':'warn','运行数据备份', bk.backed_up?'已备份':'有变更，建议「立即备份」', bk.backed_up?'mut':'warn')},
  ];
  const N=steps.length;
  for(let i=0;i<N;i++){
    stepEl.textContent='正在'+steps[i].label+'…';
    cntEl.textContent=(i+1)+' / '+N;
    await diagSleep(steps[i].slow?120:STEP_MS);   // 先亮出“正在做什么”，再出结果
    const html=await steps[i].row();
    rowsEl.insertAdjacentHTML('beforeend', html);
    bar.style.width=Math.round((i+1)/N*100)+'%';
    if(!steps[i].slow) await diagSleep(90);
  }
  spin.style.display='none';
  txtEl.classList.add('done');
  stepEl.textContent='✓ 体检完成';
  cntEl.textContent=N+' / '+N;
  diagRunning=false;
}
// 开机自动检测:统一进度条,一步一步走,让用户看清正在做什么
let _hstatT;
// 右上浮层:只显示“一次性反馈”(开机进度 / 已收录登录确认);绝对定位,淡入淡出,不占文档流、不推挤下方
function hstatShow(html, fadeMs){
  const f=document.getElementById('hstat');
  clearTimeout(_hstatT);
  f.innerHTML=html; f.className='hstat on';
  if(fadeMs) _hstatT=setTimeout(()=>{ f.className='hstat'; }, fadeMs);
}
async function bootDetect(){
  const f=document.getElementById('hstat');
  clearTimeout(_hstatT);
  f.innerHTML='<div class="boot-txt"><span class="spin"></span><span class="boot-step" id="bootStep">开始检测…</span><span class="cnt" id="bootCnt">0 / 4</span></div>'
    +'<div class="boot-bar"><i id="bootBar"></i></div>';
  f.className='hstat on';
  const bar=()=>document.getElementById('bootBar'), stepEl=()=>document.getElementById('bootStep'), cntEl=()=>document.getElementById('bootCnt');
  let pw=null;
  const steps=[
    {label:'加载账号列表与用量', run:loadAccounts},
    {label:'检测 Typeless 管理连接与当前账号', run:()=>detectCurrent(true)},   // 开机内:静默更新状态,浮层归开机进度独占
    {label:'自检去弹窗补丁（读取 app.asar，较慢）', run:async()=>{ try{ const r=await api('/api/paywall-status'); pw=r.data||{}; }catch(e){ pw={error:1}; } }},
  ];
  const N=steps.length, TOTAL=N+1;   // 3 项检查 + 第 4 步“全部填满 = 检查完成”
  for(let i=0;i<N;i++){
    const se=stepEl(), ce=cntEl();
    if(se) se.textContent='正在'+steps[i].label+'…';
    if(ce) ce.textContent=(i+1)+' / '+TOTAL;
    try{ await Promise.all([ steps[i].run(), diagSleep(320) ]); }catch(e){}
    const be=bar(); if(be) be.style.width=Math.round((i+1)/TOTAL*100)+'%';   // 25 → 50 → 75
  }
  const reverted = pw && pw.exists && pw.has_backup && !pw.patched;
  if(reverted){
    // 补丁被 Typeless 更新还原:进度浮层直接淡出,不再闪「✓ 检查完成」;告警条常驻,留在文档流占位显眼
    clearTimeout(_hstatT); f.className='hstat';
    const b=document.getElementById('patchBanner');
    b.className='banner warn'; b.style.display='flex';
    b.innerHTML='<span>⚠ 去弹窗补丁已被 Typeless 更新还原 — 点「⊘ 解除弹窗提示」可重打</span><span class="x" data-tip="忽略" onclick="this.parentElement.style.display=\'none\'">✕</span>';
  }else{
    // 完成:填满 → ✓ → 2.2s 后淡出(绝对定位,淡出不回流)
    hstatShow('<div class="boot-txt"><span class="boot-step">✓ 检查完成</span><span class="cnt">'+TOTAL+' / '+TOTAL+'</span></div>'
      +'<div class="boot-bar"><i style="width:100%"></i></div>', 2200);
  }
}
async function detectCurrent(fromBoot){
  if(CURRENT_DETECTING) return {state:CONNECTION_STATE,account_detected:Boolean(CUR_ID)};
  CURRENT_DETECTING=true;
  setConnectionUi('checking');
  try{
    const r=await api('/api/current');
    const b=document.getElementById('banner');
    if(r.status!=='OK'){
      CUR_ID=null;
      b.style.display='none'; b.textContent='';
      const state=r.data?.state==='connected'?'connected':'disconnected';
      setConnectionUi(state);
      render();
      if(!fromBoot){
        toast(state==='connected'?(r.msg||'管理连接已建立，但尚未识别当前账号'):'管理连接未开启，点「连接 Typeless」即可');
      }
      return {state,account_detected:false,code:r.code||null};
    }
    const d=r.data; CUR_ID=d.user_id;
    const matched=ACCOUNTS.find(x=>x.user_id===d.user_id);
    const label=matched?.nickname||d.nickname||d.email||d.user_id;
    setConnectionUi('connected',label);
    if(matched){
      // 已收录:卡片高亮 + 顶部胶囊已表明当前账号。收起未收录横幅;非开机场景在右上浮层做一次淡出确认(nickname==email 不重复括号)
      b.style.display='none';
      if(!fromBoot){
        const fullLabel=matched.nickname===matched.email?matched.nickname:matched.nickname+' ('+matched.email+')';
        hstatShow('<div class="boot-txt"><span class="boot-step">✓ 当前 Typeless 登录: '+esc(fullLabel)+'</span></div>', 2600);
      }
    }else{
      // 未收录:横幅是唯一能说清并引导「添加当前账号」的地方,常驻(留在文档流占位显眼)
      b.textContent='当前 Typeless 登录: '+(d.email||d.user_id)+'  — 未收录,点「添加当前账号」加入';
      b.style.display='block';
    }
    render();
    return {state:'connected',account_detected:true,matched:Boolean(matched)};
  }catch(e){
    CUR_ID=null;
    const b=document.getElementById('banner'); b.style.display='none'; b.textContent='';
    setConnectionUi('error');
    render();
    if(!fromBoot) toast('连接状态检查失败: '+(e.message||'未知错误'),'err');
    return {state:'error',account_detected:false};
  }finally{
    CURRENT_DETECTING=false;
  }
}
document.getElementById('curLink').onclick=()=>detectCurrent();

// Typeless 版本漂移探测:升级后提示可能需要复验(不自动跑复验)
async function checkVersionDrift(){
  let d;
  try{ const r=await api('/api/version-status'); if(r.status!=='OK') return; d=r.data; }catch(e){ return; }
  const b=document.getElementById('versionBanner');
  if(d.drifted){
    b.className='banner warn'; b.style.display='flex';
    b.innerHTML='<span>⚠ Typeless 已从 '+esc(d.last_seen)+' 升级到 '+esc(d.current)
      +' — 抓 token / 去弹窗补丁 / 路径探测等能力可能需要复验。确认无误后点「知道了」记为新基线。</span>'
      +'<span class="x" data-tip="把当前版本记为新基线，不再提示此版本" onclick="ackVersion()">知道了</span>';
  }else{
    b.style.display='none';
    // 首次:没有基线且能读到版本 → 悄悄建立基线,不打扰(无从追溯上次正常版本,从此刻起开始保护)
    if(!d.last_seen && d.current){ try{ await api('/api/version-ack',{method:'POST'}); }catch(e){} }
  }
}
async function ackVersion(){
  try{ await api('/api/version-ack',{method:'POST'}); }catch(e){}
  document.getElementById('versionBanner').style.display='none';
  toast('已记为当前版本基线','ok');
}

bootDetect();
checkVersionDrift();
