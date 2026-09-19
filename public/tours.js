const section=document.getElementById('tourSection');
const list=document.getElementById('tourList');
const status=document.getElementById('tourStatus');
const form=document.getElementById('newTourForm');
const setStatus=text=>{status.textContent=text;};
async function api(url,options={}){
  const response=await fetch(url,{credentials:'same-origin',...options});
  if(response.status===401){location.href='/auth/google?returnTo=/sessions';throw Error('請重新登入');}
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'操作失敗');
  return data;
}
const post=(url,body)=>api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
function button(text,onClick,disabled=false){const el=document.createElement('button');el.type='button';el.className='btn btn-secondary';el.textContent=text;el.disabled=disabled;el.addEventListener('click',onClick);return el;}
function renderTour(tour){
  const card=document.createElement('article');card.className='tour-card';
  const title=document.createElement('h3');title.textContent=tour.name;card.append(title);
  const state=document.createElement('p');state.textContent=tour.status==='closed'?'固定入口已關閉':tour.activeSessionId?'目前有場次：'+({created:'尚未開播',live:'直播中',paused:'暫停中'}[tour.activeStatus]||tour.activeStatus||'進行中'):'等待下一場';card.append(state);
  const share=document.createElement('div');share.className='tour-share';
  const qr=document.createElement('img');qr.src='/api/tours/'+encodeURIComponent(tour.id)+'/qr';qr.alt=tour.name+' 固定入場 QR';share.append(qr);
  const details=document.createElement('div');const code=document.createElement('p');code.textContent='固定碼：'+tour.code;details.append(code);
  const link=document.createElement('a');link.href=tour.viewerUrl;link.textContent=tour.viewerUrl;link.target='_blank';link.rel='noopener';details.append(link);share.append(details);card.append(share);
  const actions=document.createElement('div');actions.className='tour-card-actions';
  actions.append(button('複製固定連結',async()=>{try{await navigator.clipboard.writeText(tour.viewerUrl);setStatus('已複製固定連結');}catch{setStatus('複製失敗，請直接選取上方連結');}}));
  const download=document.createElement('a');download.className='btn btn-secondary';download.href=qr.src;download.download=tour.name+'-qr.png';download.textContent='下載 QR';actions.append(download);
  if(tour.activeSessionId){const host=document.createElement('a');host.className='btn btn-secondary';host.href='/host?id='+encodeURIComponent(tour.activeSessionId);host.textContent='回到控場';actions.append(host);}
  if(tour.status==='open')actions.append(button('更換固定碼',async()=>{
    if(!confirm('更換後舊 QR 和舊連結會立即失效。確定要換碼並重新分享嗎？'))return;
    try{await post('/api/tours/'+tour.id+'/rotate',{});setStatus('固定碼已更換，請分享新的 QR。');await loadTours();}
    catch(error){setStatus(error.message);}
  },Boolean(tour.activeSessionId)));
  if(tour.status==='open')actions.append(button('關閉固定入口',async()=>{
    if(!confirm('確定關閉「'+tour.name+'」？原 QR 將無法加入，請先結束目前場次。'))return;
    try{await post('/api/tours/'+tour.id+'/close',{});setStatus('固定入口已關閉');await loadTours();}catch(error){setStatus(error.message);}
  },Boolean(tour.activeSessionId)));
  card.append(actions);
  if(tour.status==='open'&&!tour.activeSessionId){
    const create=document.createElement('form');create.className='tour-session-form';
    const input=document.createElement('input');input.className='input';input.placeholder='本場名稱，例如：9/18 上午導覽';input.maxLength=80;input.required=true;
    const submit=document.createElement('button');submit.type='submit';submit.className='btn btn-primary';submit.textContent='開新場';
    create.append(input,submit);create.addEventListener('submit',async event=>{event.preventDefault();submit.disabled=true;try{
      const room=await post('/api/tours/'+tour.id+'/sessions',{name:input.value.trim()});location.href=room.hostUrl;
    }catch(error){setStatus(error.message);submit.disabled=false;}});card.append(create);
  }
  return card;
}
async function loadTours(){try{
  const [me,tours]=await Promise.all([api('/api/me'),api('/api/tours')]);
  const allowed=Boolean(me.features?.fixedTours);
  section.hidden=!allowed&&tours.length===0;
  form.hidden=!allowed;
  list.replaceChildren(...tours.map(renderTour));
  if(allowed&&tours.length===0)setStatus('建立一次固定入口，整趟旅程共用同一個 QR。');
}catch(error){section.hidden=false;setStatus('固定入口讀取失敗：'+error.message);}}
form.addEventListener('submit',async event=>{event.preventDefault();const submit=form.querySelector('button');submit.disabled=true;
  try{const name=document.getElementById('tourName').value.trim();await post('/api/tours',{name});form.reset();setStatus('固定入口已建立，現在可以分享 QR。');await loadTours();}
  catch(error){setStatus(error.message);}finally{submit.disabled=false;}
});
window.addEventListener('tours-changed',loadTours);
loadTours();
