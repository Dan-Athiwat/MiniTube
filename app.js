/* ========= Config & State ========= */
const DB_NAME = 'minitube-db';
const DB_VER = 1;
const MAX_FILE_MB = 512;
const state = {
  user: null,
  db: null,
  currentTab: 'feed',
  searchQuery: '',
  baseUrl: '',
};

/* ========= Utils ========= */
function uuid(){ return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
function formatDate(ts){ try{ return new Date(ts).toLocaleString(); }catch{ return '' } }
function escapeHtml(s=''){ return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function showSection(id){ for(const el of document.querySelectorAll('main > section')) el.style.display='none'; document.getElementById(id).style.display='block'; }
function setActiveTab(tab){ state.currentTab=tab; document.querySelectorAll('.tabs .tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===tab)); }
function blobUrl(blob){ try{ return blob ? URL.createObjectURL(blob) : ''; }catch{ return '' } }
function slugify(txt=''){ return (txt||'').toString().toLowerCase().trim().replace(/[^\wก-๙]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,''); }
function saveTextFile(name, content, type='text/plain'){
  const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 200);
}
function blobToDataUrl(blob){
  return new Promise((resolve,reject)=>{
    if(!blob) return resolve('');
    const reader=new FileReader(); reader.onload=()=>resolve(reader.result); reader.onerror=()=>reject(reader.error); reader.readAsDataURL(blob);
  });
}

/* ========= LocalStorage (ปลอดภัย quota) ========= */
function loadUser(){
  try{ const raw = localStorage.getItem('minitube-user'); if(raw) state.user = JSON.parse(raw); }catch{}
  if(!state.user){
    const name = prompt('ตั้งชื่อผู้ใช้ (แก้ไขได้ภายหลัง):') || '';
    const safe = name.trim() || 'ผู้ใช้-' + Math.random().toString(36).slice(2,6);
    state.user = { id: uuid(), name: safe };
    try{ localStorage.setItem('minitube-user', JSON.stringify(state.user)); }catch{}
  }
  try{ const url = localStorage.getItem('minitube-baseurl') || ''; state.baseUrl = url || ''; }catch{}
}
function saveUser(u){ state.user=u; try{ localStorage.setItem('minitube-user', JSON.stringify(u)); }catch{} }
function saveBaseUrl(url){ state.baseUrl=url.trim(); try{ localStorage.setItem('minitube-baseurl', state.baseUrl); }catch{} }

/* ========= IndexedDB ========= */
function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains('videos')){
        const s=db.createObjectStore('videos',{ keyPath:'id' });
        s.createIndex('channelId','channelId'); s.createIndex('createdAt','createdAt'); s.createIndex('title','title');
      }
      if(!db.objectStoreNames.contains('channels')){
        const s=db.createObjectStore('channels',{ keyPath:'id' });
        s.createIndex('ownerId','ownerId');
      }
      if(!db.objectStoreNames.contains('comments')){
        const s=db.createObjectStore('comments',{ keyPath:'id' });
        s.createIndex('videoId','videoId'); s.createIndex('createdAt','createdAt');
      }
      if(!db.objectStoreNames.contains('likes')){
        const s=db.createObjectStore('likes',{ keyPath:'id' });
        s.createIndex('videoId_userId',['videoId','userId'],{ unique:true });
      }
      if(!db.objectStoreNames.contains('subs')){
        const s=db.createObjectStore('subs',{ keyPath:'id' });
        s.createIndex('channelId_userId',['channelId','userId'],{ unique:true });
      }
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
function tx(storeNames, mode='readonly'){ const t=state.db.transaction(storeNames, mode); return { t, stores: storeNames.map(n=>t.objectStore(n)) }; }
function getAll(storeName){ return new Promise((res,rej)=>{ const {stores:[s]}=tx([storeName]); const r=s.getAll(); r.onsuccess=()=>res(r.result||[]); r.onerror=()=>rej(r.error); }); }
function put(storeName,obj){ return new Promise((res,rej)=>{ const {stores:[s]}=tx([storeName],'readwrite'); const r=s.put(obj); r.onsuccess=()=>res(obj); r.onerror=()=>rej(r.error); }); }
function del(storeName,key){ return new Promise((res,rej)=>{ const {stores:[s]}=tx([storeName],'readwrite'); const r=s.delete(key); r.onsuccess=()=>res(); r.onerror=()=>rej(r.error); }); }
function indexQuery(storeName,indexName,keyRange=null,direction='prev'){
  return new Promise((res,rej)=>{ const {stores:[s]}=tx([storeName]); const idx=s.index(indexName); const r=idx.openCursor(keyRange,direction); const out=[]; r.onsuccess=(e)=>{ const c=e.target.result; if(c){ out.push(c.value); c.continue(); } else res(out); }; r.onerror=()=>rej(r.error); });
}

/* ========= Channels ========= */
async function getMyChannel(){ const all=await getAll('channels'); return all.find(c=>c.ownerId===state.user.id)||null; }
async function ensureMyChannel(){
  let ch = await getMyChannel();
  if(!ch){ ch = { id:uuid(), ownerId:state.user.id, name:`${state.user.name} Channel`, desc:'ยินดีต้อนรับสู่ช่องของฉัน!', createdAt:Date.now(), slug:'' }; await put('channels', ch); }
  return ch;
}
async function getChannelById(id){ const all=await getAll('channels'); return all.find(c=>c.id===id)||null; }

/* ========= Videos ========= */
async function addVideo({ file, title, desc, channelId }){
  if(!file) throw new Error('ไม่ได้เลือกไฟล์วิดีโอ');
  const mb=(file.size||0)/(1024*1024); if(mb>MAX_FILE_MB) throw new Error(`ไฟล์ใหญ่เกิน ${MAX_FILE_MB} MB`);
  const thumbBlob=await generateThumbnail(file).catch(()=>null);
  const v={ id:uuid(), title:title?.trim()||file.name||'Untitled', desc:desc?.trim()||'', channelId, createdAt:Date.now(), blob:file, thumbBlob, likesCount:0, slug:'' };
  v.slug = slugify(v.title) || ('video-'+v.id.slice(-6));
  await put('videos', v); return v;
}
async function generateThumbnail(file){
  return new Promise((resolve,reject)=>{
    try{
      const url=URL.createObjectURL(file); const vid=document.createElement('video');
      vid.preload='metadata'; vid.src=url; vid.muted=true; vid.playsInline=true;
      vid.onloadeddata=async ()=>{
        try{
          vid.currentTime=Math.min(0.1, vid.duration||0); await vid.play().catch(()=>{});
          const canvas=document.createElement('canvas'); const w=640, h=Math.round(w*9/16);
          canvas.width=w; canvas.height=h; const ctx=canvas.getContext('2d'); ctx.drawImage(vid,0,0,w,h);
          canvas.toBlob(b=>{ URL.revokeObjectURL(url); b?resolve(b):reject(new Error('สร้างภาพปกไม่สำเร็จ')); }, 'image/jpeg', 0.8);
        }catch(e){ URL.revokeObjectURL(url); reject(e); }
      };
      vid.onerror=()=>{ URL.revokeObjectURL(url); reject(new Error('อ่านวิดีโอไม่ได้')) };
    }catch(e){ reject(e) }
  });
}
async function listRecentVideos(limit=200){ const arr=await indexQuery('videos','createdAt',null,'prev'); return arr.slice(0,limit); }

/* ========= Likes & Comments ========= */
async function toggleLike(videoId){
  const likes=await getAll('likes'); const ex=likes.find(l=>l.videoId===videoId && l.userId===state.user.id);
  if(ex) await del('likes', ex.id); else await put('likes', { id:uuid(), videoId, userId:state.user.id });
  const vids=await getAll('videos'); const v=vids.find(x=>x.id===videoId);
  if(v){ const count=(await getAll('likes')).filter(l=>l.videoId===videoId).length; v.likesCount=count; await put('videos', v); }
}
async function addComment(videoId,text){
  const t=text?.trim(); if(!t) throw new Error('คอมเมนต์ว่างเปล่า');
  const c={ id:uuid(), videoId, userId:state.user.id, userName:state.user.name, text:t, createdAt:Date.now() };
  await put('comments', c); return c;
}
async function listComments(videoId){ const all=await indexQuery('comments','createdAt',null,'prev'); return all.filter(c=>c.videoId===videoId); }

/* ========= Subs ========= */
async function toggleSub(channelId){ const all=await getAll('subs'); const ex=all.find(s=>s.channelId===channelId && s.userId===state.user.id); if(ex) await del('subs', ex.id); else await put('subs', { id:uuid(), channelId, userId:state.user.id }); }
async function listMySubs(){ const all=await getAll('subs'); return all.filter(s=>s.userId===state.user.id).map(s=>s.channelId); }
async function isSubbed(channelId){ const subs=await listMySubs(); return subs.includes(channelId); }

/* ========= Routing (Permalink) ========= */
async function handlePermalink(){
  const params=new URLSearchParams(location.search);
  const vid=params.get('v'); const ch=params.get('c');
  if(vid) return openVideo(vid);
  if(ch) return openChannel(ch);
  return renderFeed();
}

/* ========= Rendering ========= */
function renderCards(videos){
  const div=document.createElement('div'); div.className='grid';
  if(!videos.length){ const e=document.createElement('div'); e.className='empty'; e.textContent='ยังไม่มีวิดีโอ'; return e; }
  for(const v of videos){
    const card=document.createElement('div'); card.className='card';
    const imgUrl=blobUrl(v.thumbBlob);
    const img=document.createElement(imgUrl?'img':'div'); if(imgUrl){ img.src=imgUrl; img.className='thumb'; } else { img.className='thumb'; }
    img.onclick=()=>openVideo(v.id);
    const c=document.createElement('div'); c.className='content';
    c.innerHTML=`
      <div class="row">
        <div style="font-weight:600; flex:1">${escapeHtml(v.title)}</div>
        <div class="pill small">${v.likesCount||0} ไลก์</div>
      </div>
      <div class="muted small">${formatDate(v.createdAt)}</div>
      <div class="row" style="margin-top:6px">
        <a class="pill small" href="?v=${encodeURIComponent(v.id)}">ลิงก์ถาวร</a>
      </div>`;
    card.appendChild(img); card.appendChild(c); div.appendChild(card);
  }
  return div;
}

async function openVideo(videoId){
  try{
    const vids=await getAll('videos'); const v=vids.find(x=>x.id===videoId);
    if(!v) return alert('ไม่พบวิดีโอนี้');
    const ch=await getChannelById(v.channelId); const comments=await listComments(videoId);
    showSection('videoView'); const el=document.getElementById('videoView'); el.innerHTML='';
    const wrap=document.createElement('div'); wrap.className='flex';
    const left=document.createElement('div'); left.className='left section';
    const right=document.createElement('div'); right.className='right section';

    const url=blobUrl(v.blob);
    const player=document.createElement('video'); player.controls=true; player.className='video-player'; player.src=url; left.appendChild(player);

    const title=document.createElement('h2'); title.textContent=v.title; left.appendChild(title);

    const row=document.createElement('div'); row.className='row';
    const likeBtn=document.createElement('button'); likeBtn.textContent='ไลก์'; likeBtn.onclick=async()=>{ await toggleLike(v.id); openVideo(v.id); };
    const likeCount=document.createElement('div'); likeCount.className='pill'; likeCount.textContent=`${v.likesCount||0} ไลก์`;
    const channelLink=document.createElement('button'); channelLink.className='secondary'; channelLink.textContent=ch?`ไปที่ช่อง: ${ch.name}`:'ช่องไม่พบ'; channelLink.onclick=()=>openChannel(v.channelId);
    row.appendChild(likeBtn); row.appendChild(likeCount); row.appendChild(channelLink); left.appendChild(row);

    const desc=document.createElement('div'); desc.className='muted'; desc.textContent=v.desc||''; left.appendChild(desc);

    const perm=document.createElement('div'); perm.className='row'; const a=document.createElement('a'); a.href=`?v=${encodeURIComponent(v.id)}`; a.className='pill'; a.textContent='ลิงก์ถาวร'; perm.appendChild(a); left.appendChild(perm);

    const cTitle=document.createElement('h3'); cTitle.textContent='คอมเมนต์'; left.appendChild(cTitle);
    const form=document.createElement('div'); form.innerHTML=`
      <label>พิมพ์คอมเมนต์ของคุณ</label>
      <textarea id="commentText"></textarea>
      <div class="row"><button id="sendComment" class="green">ส่งคอมเมนต์</button></div>
      <div class="divider"></div>`;
    left.appendChild(form);
    form.querySelector('#sendComment').onclick=async()=>{ try{ const text=form.querySelector('#commentText').value; await addComment(v.id,text); openVideo(v.id); }catch(e){ alert(e.message||'ส่งคอมเมนต์ผิดพลาด'); } };

    if(!comments.length){ const em=document.createElement('div'); em.className='empty'; em.textContent='ยังไม่มีคอมเมนต์'; left.appendChild(em); }
    else { for(const c of comments){ const item=document.createElement('div'); item.className='section'; item.innerHTML=`<div style="font-weight:600">${escapeHtml(c.userName)}</div><div class="muted small">${formatDate(c.createdAt)}</div><div style="margin-top:6px">${escapeHtml(c.text)}</div>`; left.appendChild(item); } }

    const chBox=document.createElement('div');
    chBox.innerHTML=`
      <h3>ช่อง</h3>
      <div><strong>${escapeHtml(ch?.name||'ช่องไม่พบ')}</strong></div>
      <div class="muted small" style="margin-top:6px">${escapeHtml(ch?.desc||'')}</div>
      <div class="row" style="margin-top:10px">
        <button id="subBtn">${await isSubbed(ch?.id)?'เลิกติดตาม':'ติดตาม'}</button>
        <button id="exportVideo" class="secondary">สร้างหน้าเว็บสาธารณะ (วิดีโอนี้)</button>
      </div>
      <div class="hint small" style="margin-top:8px">ตั้งค่า Base URL ในหน้าโปรไฟล์ก่อน เพื่อให้ลิงก์ OG/RSS/Sitemap ถูกต้อง</div>`;
    right.appendChild(chBox);
    right.querySelector('#subBtn').onclick=async()=>{ await toggleSub(ch.id); openVideo(v.id); };
    right.querySelector('#exportVideo').onclick=()=> exportPublicVideoPage(v, ch);

    wrap.appendChild(left); wrap.appendChild(right); el.appendChild(wrap);
    history.replaceState(null, '', `?v=${encodeURIComponent(v.id)}`);
  }catch(e){ alert(e.message||'เปิดวิดีโอผิดพลาด'); }
}

async function openChannel(channelId){
  try{
    const ch=await getChannelById(channelId); if(!ch) return alert('ไม่พบช่องนี้');
    showSection('channelView'); const el=document.getElementById('channelView'); el.innerHTML='';
    const box=document.createElement('div'); box.className='section';
    box.innerHTML=`
      <h2>${escapeHtml(ch.name)}</h2>
      <div class="muted">${escapeHtml(ch.desc)}</div>
      <div class="row" style="margin-top:10px">
        <button id="subBtn">${await isSubbed(ch.id)?'เลิกติดตาม':'ติดตาม'}</button>
        ${ch.ownerId===state.user.id ? '<button id="editCh" class="secondary">แก้ไขช่อง</button>' : ''}
        <button id="exportChannel" class="secondary">สร้างหน้าเว็บสาธารณะ (ช่อง)</button>
      </div>
      <div class="hint small" style="margin-top:8px">ตั้งค่า Base URL ในหน้าโปรไฟล์ก่อน เพื่อให้ลิงก์ OG/RSS/Sitemap ถูกต้อง</div>`;
    el.appendChild(box);
    box.querySelector('#subBtn').onclick=async()=>{ await toggleSub(ch.id); openChannel(ch.id); };
    if(ch.ownerId===state.user.id){
      box.querySelector('#editCh').onclick=async()=>{
        const name=prompt('ชื่อช่องใหม่', ch.name)||ch.name;
        const desc=prompt('คำอธิบายช่องใหม่', ch.desc)||ch.desc;
        ch.name=(name.trim()||ch.name); ch.desc=(desc.trim()||ch.desc); ch.slug=slugify(ch.name)||('channel-'+ch.id.slice(-6));
        await put('channels', ch); openChannel(ch.id);
      };
    }
    box.querySelector('#exportChannel').onclick=()=> exportPublicChannelPage(ch);

    const vids=(await listRecentVideos(200)).filter(v=>v.channelId===ch.id);
    el.appendChild(renderCards(vids));
    history.replaceState(null, '', `?c=${encodeURIComponent(ch.id)}`);
  }catch(e){ alert(e.message||'เปิดช่องผิดพลาด'); }
}

/* ========= Views ========= */
async function renderFeed(){
  showSection('feedView'); setActiveTab('feed');
  const subs=await listMySubs(); const vids=await listRecentVideos(100);
  const feed=vids.filter(v=>subs.includes(v.channelId));
  const el=document.getElementById('feedView'); el.innerHTML='<h2>ฟีด</h2>'; el.appendChild(renderCards(feed));
}
async function renderExplore(){
  showSection('exploreView'); setActiveTab('explore');
  const vids=await listRecentVideos(100); const el=document.getElementById('exploreView');
  el.innerHTML='<h2>สำรวจ</h2>'; el.appendChild(renderCards(vids));
}
async function renderSubs(){
  showSection('subscriptionsView'); setActiveTab('subscriptions');
  const subs=await listMySubs(); const channels=await getAll('channels'); const my=channels.filter(c=>subs.includes(c.id));
  const el=document.getElementById('subscriptionsView'); el.innerHTML='<h2>ช่องที่ติดตาม</h2>';
  if(!my.length){ const em=document.createElement('div'); em.className='empty'; em.textContent='ยังไม่ได้ติดตามช่องใด'; el.appendChild(em); return; }
  const wrap=document.createElement('div'); wrap.className='grid';
  for(const c of my){
    const card=document.createElement('div'); card.className='card';
    const content=document.createElement('div'); content.className='content';
    content.innerHTML=`
      <div style="font-weight:600">${escapeHtml(c.name)}</div>
      <div class="muted small">${escapeHtml(c.desc)}</div>
      <div class="row" style="margin-top:8px">
        <button class="secondary">เปิดช่อง</button>
        <button>${await isSubbed(c.id)?'เลิกติดตาม':'ติดตาม'}</button>
      </div>`;
    const btns=content.querySelectorAll('button');
    btns[0].onclick=()=>openChannel(c.id);
    btns[1].onclick=async()=>{ await toggleSub(c.id); renderSubs(); };
    card.appendChild(content); wrap.appendChild(card);
  }
  el.appendChild(wrap);
}
async function renderProfile(){
  showSection('profileView');
  const el=document.getElementById('profileView'); el.innerHTML='<h2>โปรไฟล์/ช่องของฉัน</h2>';
  const ch=await ensureMyChannel();
  const box=document.createElement('div'); box.className='section';
  box.innerHTML=`
    <div class="row">
      <div><strong>ผู้ใช้:</strong> ${escapeHtml(state.user.name)}</div>
      <button id="renameUser" class="secondary">แก้ไขชื่อผู้ใช้</button>
    </div>
    <div class="divider"></div>
    <h3>ตั้งค่าเผยแพร่</h3>
    <label>Base URL (โดเมนจริงที่คุณจะโฮสต์ เช่น https://yourname.netlify.app)</label>
    <input id="baseUrl" type="text" placeholder="https://example.com" value="${escapeHtml(state.baseUrl||'')}"/>
    <div class="row" style="margin-top:8px">
      <button id="saveBase" class="green">บันทึก</button>
      <button id="exportAll" class="secondary">สร้างไฟล์สาธารณะทั้งหมด (ช่อง/วิดีโอ/Sitemap/RSS/PWA)</button>
    </div>
    <div class="hint small" style="margin-top:8px">
      โฮสต์ไฟล์ที่สร้างบน Netlify/Vercel/GitHub Pages แล้วส่ง <code>sitemap.xml</code> เข้า Search Console เพื่อให้ Google เก็บข้อมูลเร็วขึ้น
    </div>

    <div class="divider"></div>
    <h3>ช่องของฉัน</h3>
    <label>ชื่อช่อง</label>
    <input id="chName" type="text" value="${escapeHtml(ch.name)}"/>
    <label>คำอธิบายช่อง</label>
    <textarea id="chDesc">${escapeHtml(ch.desc)}</textarea>
    <div class="row" style="margin-top:8px">
      <button id="saveCh" class="green">บันทึก</button>
      <button id="openCh" class="secondary">เปิดช่อง</button>
    </div>
    <div class="warning" style="margin-top:10px">ข้อมูลทั้งหมดเก็บบนเครื่องคุณ หากลบแคช/IndexedDB ข้อมูลจะหาย</div>`;
  el.appendChild(box);

  box.querySelector('#renameUser').onclick=()=>{ const name=prompt('ชื่อผู้ใช้ใหม่', state.user.name)||state.user.name; saveUser({ ...state.user, name:(name.trim()||state.user.name) }); renderProfile(); };
  box.querySelector('#saveBase').onclick=()=>{ const url=document.getElementById('baseUrl').value; saveBaseUrl(url); alert('บันทึก Base URL เรียบร้อย'); };
  box.querySelector('#saveCh').onclick=async()=>{ ch.name=document.getElementById('chName').value.trim()||ch.name; ch.desc=document.getElementById('chDesc').value.trim()||ch.desc; ch.slug=slugify(ch.name)||('channel-'+ch.id.slice(-6)); await put('channels', ch); alert('บันทึกช่องเรียบร้อย'); };
  box.querySelector('#openCh').onclick=()=>openChannel(ch.id);
  box.querySelector('#exportAll').onclick=async()=>{
    if(!state.baseUrl) return alert('กรุณาตั้ง Base URL ก่อน');
    const me=await ensureMyChannel();
    await exportPublicChannelPage(me);
    const vids=(await listRecentVideos(999)).filter(v=>v.channelId===me.id);
    for(const v of vids) await exportPublicVideoPage(v, me);
    await exportSitemapAndRSS(me, vids);
    await exportPWAArtifacts();
    alert('สร้างไฟล์สาธารณะทั้งหมดเรียบร้อย (ดาวน์โหลดแล้ว)');
  };

  const vids=(await listRecentVideos(200)).filter(v=>v.channelId===ch.id);
  const sec=document.createElement('div'); sec.className='section';
  sec.innerHTML=`<h3>วิดีโอของฉัน (${vids.length})</h3>`; sec.appendChild(renderCards(vids)); el.appendChild(sec);
}
function renderUpload(){
  showSection('uploadView');
  const el=document.getElementById('uploadView');
  el.innerHTML=`
    <h2>อัปโหลดวิดีโอ</h2>
    <div class="section">
      <label>ไฟล์วิดีโอ (MP4/WebM)</label>
      <input id="fileInput" type="file" accept="video/mp4,video/webm"/>
      <label>ชื่อวิดีโอ</label>
      <input id="vidTitle" type="text" placeholder="ตั้งชื่อคลิป..."/>
      <label>คำอธิบาย</label>
      <textarea id="vidDesc" placeholder="เพิ่มรายละเอียด..."></textarea>
      <div class="row" style="margin-top:8px">
        <button id="doUpload" class="green">อัปโหลด</button>
        <span class="muted small">สูงสุด ~${MAX_FILE_MB} MB</span>
      </div>
    </div>`;
  document.getElementById('doUpload').onclick=async()=>{
    try{
      const file=document.getElementById('fileInput').files[0]; if(!file) return alert('กรุณาเลือกไฟล์วิดีโอ');
      const title=document.getElementById('vidTitle').value; const desc=document.getElementById('vidDesc').value;
      const ch=await ensureMyChannel(); const v=await addVideo({ file, title, desc, channelId: ch.id });
      alert('อัปโหลดสำเร็จ'); openVideo(v.id);
    }catch(e){ alert(e.message||'อัปโหลดผิดพลาด'); }
  };
}

/* ========= Search ========= */
async function doSearch(query){
  state.searchQuery=query; const vids=await listRecentVideos(300);
  const q=(query||'').toLowerCase();
  const filtered=vids.filter(v=> v.title?.toLowerCase().includes(q) || v.desc?.toLowerCase().includes(q));
  showSection('exploreView'); setActiveTab('explore'); const el=document.getElementById('exploreView');
  el.innerHTML=`<h2>ผลการค้นหา: "${escapeHtml(query)}"</h2>`; el.appendChild(renderCards(filtered));
}

/* ========= Export: SEO Static Pages ========= */
function buildOGMeta({ title, desc, url, imageUrl }){
  return `
    <meta property="og:type" content="video.other">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(desc||'')}">
    <meta property="og:url" content="${escapeHtml(url)}">
    ${imageUrl ? `<meta property="og:image" content="${escapeHtml(imageUrl)}">` : ''}
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(desc||'')}">
    ${imageUrl ? `<meta name="twitter:image" content="${escapeHtml(imageUrl)}">` : ''}
  `;
}
function buildVideoJSONLD({ title, desc, url, thumbnailUrl, uploadDate, channelName }){
  return {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    "name": title,
    "description": desc || "",
    "thumbnailUrl": thumbnailUrl ? [thumbnailUrl] : [],
    "uploadDate": new Date(uploadDate).toISOString(),
    "publisher": { "@type":"Organization", "name": channelName },
    "contentUrl": url,
    "embedUrl": url
  };
}
function buildChannelJSONLD({ name, desc, url }){
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": name,
    "description": desc || "",
    "url": url
  };
}
async function exportPublicVideoPage(v, ch){
  if(!state.baseUrl) return alert('กรุณาตั้ง Base URL ก่อน');
  const base=state.baseUrl.replace(/\/+$/,'');
  const videoUrl=`${base}/video-${encodeURIComponent(v.slug||('video-'+v.id.slice(-6)))}.html`;
  const thumbDataUrl=await blobToDataUrl(v.thumbBlob).catch(()=>null);
  const jsonld=buildVideoJSONLD({ title:v.title, desc:v.desc, url:videoUrl, thumbnailUrl:thumbDataUrl||'', uploadDate:v.createdAt, channelName:ch?.name||'Channel' });
  const og=buildOGMeta({ title:v.title, desc:v.desc, url:videoUrl, imageUrl:thumbDataUrl||'' });

  const html=`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${escapeHtml(v.title)} — ${escapeHtml(ch?.name||'ช่อง')}</title>
  <meta name="description" content="${escapeHtml(v.desc||'')}">
  ${og}
  <link rel="manifest" href="manifest.webmanifest"><meta name="theme-color" content="#0f0f0f">
  <script type="application/ld+json">${escapeHtml(JSON.stringify(jsonld))}</script>
  <style>
    body{background:#0f0f0f;color:#f3f3f3;font-family:system-ui,Segoe UI,Roboto,Arial;margin:0}
    main{max-width:900px;margin:0 auto;padding:16px}
    .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:12px;margin:12px 0}
    .muted{color:#a0a0a0} video{width:100%;border-radius:8px;background:#000} a{color:#fff}
  </style>
</head>
<body>
<main>
  <h1>${escapeHtml(v.title)}</h1>
  <div class="muted">${escapeHtml(ch?.name||'ช่องไม่พบ')} • ${escapeHtml(new Date(v.createdAt).toLocaleString())}</div>
  <div class="card">
    <video controls src=""></video>
    <p class="muted">หมายเหตุ: ต้องโฮสต์ไฟล์วิดีโอจริงในคลาวด์แล้วแก้ src เป็น URL ของไฟล์นั้น</p>
  </div>
  <div class="card"><strong>คำอธิบาย:</strong><br>${escapeHtml(v.desc||'')}</div>
  <div class="card"><a href="channel.html">ไปที่ช่อง</a></div>
</main>
</body>
</html>`;
  const fname=`video-${(v.slug||('video-'+v.id.slice(-6)))}.html`;
  saveTextFile(fname, html, 'text/html');
}
async function exportPublicChannelPage(ch){
  if(!state.baseUrl) return alert('กรุณาตั้ง Base URL ก่อน');
  ch.slug=ch.slug||slugify(ch.name)||('channel-'+ch.id.slice(-6));
  const base=state.baseUrl.replace(/\/+$/,'');
  const channelUrl=`${base}/channel.html`;
  const jsonld=buildChannelJSONLD({ name:ch.name, desc:ch.desc, url:channelUrl });
  const vids=(await listRecentVideos(200)).filter(v=>v.channelId===ch.id);
  const links=vids.map(v=>{ const slug=v.slug||slugify(v.title)||('video-'+v.id.slice(-6)); return `<li><a href="video-${slug}.html">${escapeHtml(v.title)}</a></li>`; }).join('\n');

  const html=`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${escapeHtml(ch.name)} — ช่อง</title>
  <meta name="description" content="${escapeHtml(ch.desc||'ช่องวิดีโอ')}">
  ${buildOGMeta({ title:ch.name, desc:ch.desc, url:channelUrl, imageUrl:'' })}
  <link rel="manifest" href="manifest.webmanifest"><meta name="theme-color" content="#0f0f0f">
  <script type="application/ld+json">${escapeHtml(JSON.stringify(jsonld))}</script>
  <style>
    body{background:#0f0f0f;color:#f3f3f3;font-family:system-ui,Segoe UI,Roboto,Arial;margin:0}
    main{max-width:900px;margin:0 auto;padding:16px}
    .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:12px;margin:12px 0}
    a{color:#fff} .muted{color:#a0a0a0}
  </style>
</head>
<body>
<main>
  <h1>${escapeHtml(ch.name)}</h1>
  <div class="muted">${escapeHtml(ch.desc||'')}</div>
  <div class="card">
    <h2>วิดีโอล่าสุด</h2>
    <ul>${links||'<li>ยังไม่มีวิดีโอ</li>'}</ul>
  </div>
</main>
</body>
</html>`;
  saveTextFile('channel.html', html, 'text/html');
}
async function exportSitemapAndRSS(ch, vids){
  const base=state.baseUrl.replace(/\/+$/,'');
  const urls=[ `${base}/channel.html`, ...vids.map(v=> `${base}/video-${encodeURIComponent(v.slug||('video-'+v.id.slice(-6)))}.html`) ];
  const sitemap=`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u=>`  <url><loc>${u}</loc><lastmod>${new Date().toISOString()}</lastmod></url>`).join('\n')}
</urlset>`;
  saveTextFile('sitemap.xml', sitemap, 'application/xml');

  const rssItems=vids.map(v=>{
    const link=`${base}/video-${encodeURIComponent(v.slug||('video-'+v.id.slice(-6)))}.html`;
    return `
    <item>
      <title>${escapeHtml(v.title)}</title>
      <link>${link}</link>
      <guid>${link}</guid>
      <pubDate>${new Date(v.createdAt).toUTCString()}</pubDate>
      <description>${escapeHtml(v.desc||'')}</description>
    </item>`;
  }).join('\n');
  const rss=`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeHtml(ch.name)} — ฟีด</title>
    <link>${base}/channel.html</link>
    <description>${escapeHtml(ch.desc||'')}</description>
${rssItems}
  </channel>
</rss>`;
  saveTextFile('rss.xml', rss, 'application/rss+xml');
}
async function exportPWAArtifacts(){
  const manifest={ name:"MiniTube Public", short_name:"MiniTube", start_url:"channel.html", display:"standalone", background_color:"#0f0f0f", theme_color:"#0f0f0f", icons:[] };
  saveTextFile('manifest.webmanifest', JSON.stringify(manifest, null, 2), 'application/manifest+json');
  const sw=`self.addEventListener('install', e=>{ self.skipWaiting(); });
self.addEventListener('activate', e=>{});
self.addEventListener('fetch', e=>{ /* passthrough */ });`;
  saveTextFile('sw.js', sw, 'text/javascript');
}

/* ========= Event Binding ========= */
function bindUI(){
  document.querySelectorAll('.tabs .tab').forEach(tab=>{
    tab.onclick=async()=>{
      const t=tab.dataset.tab;
      if(t==='feed') await renderFeed();
      else if(t==='explore') await renderExplore();
      else if(t==='subscriptions') await renderSubs();
    };
  });
  document.getElementById('uploadBtn').onclick=()=>renderUpload();
  document.getElementById('myChannelBtn').onclick=()=>renderProfile();
  document.getElementById('searchInput').addEventListener('keydown',(e)=>{ if(e.key==='Enter') doSearch(e.target.value); });
  window.addEventListener('popstate', handlePermalink);
}

/* ========= Boot ========= */
(async function boot(){
  try{
    loadUser();
    state.db = await openDB();
    bindUI();
    await ensureMyChannel();
    await handlePermalink();
    if('serviceWorker' in navigator){ try{ navigator.serviceWorker.register('sw.js'); }catch{} }
  }catch(e){
    const root=document.querySelector('main');
    root.innerHTML = `<div class="section danger">เกิดข้อผิดพลาดในการเริ่มระบบ: ${escapeHtml(e.message||'')}</div>`;
  }
})();