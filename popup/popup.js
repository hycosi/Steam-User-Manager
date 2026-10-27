'use strict';
const $ = selector => document.querySelector(selector);
const svgNS = 'http://www.w3.org/2000/svg';
const state = {accounts: [], activeId: null, version: ''};
let detail = null, editId = null, pendingBackup = null, previewToken = 0;
let guardExpiresAt = 0, guardBusy = false, guardTimer, toastTimer, menuReturnFocus, bookmarkEditN = null;
const plural = count => `${count} ${count % 100 >= 11 && count % 100 <= 14 ? 'аккаунтов' : count % 10 === 1 ? 'аккаунт' : [2,3,4].includes(count % 10) ? 'аккаунта' : 'аккаунтов'}`;
const icon = name => {
  const svg = document.createElementNS(svgNS, 'svg'), use = document.createElementNS(svgNS, 'use');
  use.setAttribute('href', `icons.svg#${name}`); svg.setAttribute('aria-hidden','true'); svg.append(use); return svg;
};
const node = (tag, className, text) => {const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;return element;};
function toast(text, error = false) {
  const element=$('#toast'); element.textContent=text; element.toggleAttribute('data-error',error);element.hidden=false;
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>element.hidden=true,5000);
}
function errorIn(selector, error) {const element=$(selector);element.textContent=error?.message || String(error);element.hidden=false;}
async function request(message) {
  const result=await chrome.runtime.sendMessage(message);
  if(result?.error)throw new Error(result.error);
  return result;
}
const accountById = id => state.accounts.find(account=>account.id===id);
function openDialog(selector) {closeMenu();const dialog=$(selector);if(!dialog.open)dialog.showModal();return dialog;}
function safeImage(url) {try {const value=new URL(url);return value.protocol==='https:'?value.href:null;}catch{return null;}}
function avatar(account) {
  const fallback=()=>node('div','avatar avatar-fallback',(account.name || account.login || '?').slice(0,1).toUpperCase());
  const url=safeImage(account.avatar);if(!url)return fallback();
  const image=node('img','avatar');image.src=url;image.alt='';image.addEventListener('error',()=>image.replaceWith(fallback()),{once:true});return image;
}
function render() {
  const query=$('#search_acc').value.trim().toLowerCase();
  const shown=state.accounts.filter(account=>[account.login,account.name].some(value=>String(value||'').toLowerCase().includes(query)));
  $('#account-count').textContent=query?`${shown.length} из ${plural(state.accounts.length)}`:plural(state.accounts.length);
  $('#export-count').textContent=plural(state.accounts.length);
  const inventory=[['Пароли',state.accounts.filter(account=>account.hasPassword).length],['Steam Guard',state.accounts.filter(account=>account.secret.shared).length],['Данные подтверждений',state.accounts.filter(account=>account.secret.identity).length],['Сохранённые сессии',state.accounts.filter(account=>account.hasSession).length],['Ссылки',state.accounts.reduce((count,account)=>count+account.tabs.length,0)]];
  $('#backup-inventory').replaceChildren(...inventory.map(([label,value])=>{const row=node('div');row.append(node('dt',null,label),node('dd',null,String(value)));return row;}));
  $('#export-accounts').disabled=!state.accounts.length;
  $('#app-version').textContent=`v${state.version}`;
  const list=$('#accounts-list');list.replaceChildren();list.setAttribute('aria-busy','false');
  $('#empty-state').hidden=state.accounts.length>0;$('#no-results').hidden=!state.accounts.length || shown.length>0;
  for(const account of shown) {
    const row=node('article','account-row user');row.dataset.id=account.id;
    const photo=node('button','avatar-button');photo.type='button';photo.setAttribute('aria-label',`Открыть данные ${account.login}`);photo.append(avatar(account));photo.addEventListener('click',()=>showDetails(account.id).catch(error=>toast(error.message,true)));
    const identity=node('div','account-identity');
    const name=node('button','account-name',account.name || account.login);name.type='button';name.title=account.name || account.login;name.addEventListener('click',()=>showDetails(account.id).catch(error=>toast(error.message,true)));
    const subline=node('div','account-subline');subline.append(node('span','account-login',account.login));
    if(account.secret.shared){const guard=icon('shield');guard.classList.add('guard-mark');guard.setAttribute('aria-label','Steam Guard подключён');subline.append(guard);}
    if(state.activeId===account.id)subline.append(node('span','browser-mark','В браузере'));
    else if(!account.hasSession)subline.append(node('span','account-level','Нужен вход'));
    else if(account.level!==undefined)subline.append(node('span','account-level',`Уровень ${account.level}`));
    identity.append(name,subline);
    const actions=node('div','row-actions');
    const open=node('button','button','Открыть');open.type='button';open.title=`Открыть ${account.login} в отдельной сессии Steam`;open.addEventListener('click',()=>runAccount('go_over',account.id,open));
    const more=node('button','icon-button');more.type='button';more.append(icon('more'));more.setAttribute('aria-label',`Действия с ${account.login}`);more.setAttribute('aria-haspopup','menu');more.addEventListener('click',event=>{event.stopPropagation();showMenu(account,more);});
    actions.append(open,more);
    const quick=node('div','quick-actions');
    const quickButton=(glyph,label,handler,className='')=>{const button=node('button',`quick-button ${className}`.trim());button.type='button';button.append(icon(glyph));button.title=label;button.setAttribute('aria-label',`${label}: ${account.login}`);button.addEventListener('click',handler);return button;};
    quick.append(
      quickButton('user','Сделать основным в браузере',()=>runAccount('switch',account.id),state.activeId===account.id?'active':''),
      quickButton('open','Открыть в новой вкладке',()=>runAccount('go_over',account.id)),
      quickButton('refresh','Войти заново',()=>reauthorize(account.id).catch(error=>toast(error.message,true)))
    );
    const videoUrl=safeImage(account.video);
    if(videoUrl){
      row.classList.add('has-bg');
      const video=node('video','row-bg');video.src=videoUrl;video.muted=true;video.loop=true;video.autoplay=true;video.playsInline=true;video.setAttribute('aria-hidden','true');video.addEventListener('error',()=>{video.remove();row.classList.remove('has-bg');},{once:true});row.append(video);
    }
    if(state.activeId===account.id)row.classList.add('is-active');
    row.append(quick,photo,identity,actions);list.append(row);
  }
}
async function loadState() {Object.assign(state,await request({type:'ui:state'}));render();}
function showView(view) {
  $('#accounts-view').hidden=view!=='accounts';$('#backup-view').hidden=view!=='backup';
  for(const name of ['accounts','backup']) {
    const title=$(`#${name}-view .title-row`).querySelector('h1,h2');
    const tag=name===view?'H1':'H2';
    if(title.tagName!==tag)title.replaceWith(node(tag.toLowerCase(),null,title.textContent));
  }
  document.querySelectorAll('[data-view]').forEach(button=>{if(button.dataset.view===view)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
  $('#footer-hint').textContent=view==='accounts'?'«Открыть» — отдельная сессия Steam':'Резервная копия сохраняется на вашем устройстве';
  $('#main').scrollTop=0;closeMenu();
}
function closeMenu(restoreFocus=false) {$('#account-menu').hidden=true;if(restoreFocus)menuReturnFocus?.focus();}
function showMenu(account,anchor) {
  const menu=$('#account-menu');menu.replaceChildren();menuReturnFocus=anchor;
  const items=[
    ['switch','Сделать основным в браузере',()=>runAccount('switch',account.id)],
    ['shield','Steam Guard и ссылки',()=>showDetails(account.id)],
    ...(account.secret.identity?[['check','Подтверждения',()=>runAccount('confirm',account.id)]]:[]),
    ['edit','Редактировать',()=>editAccount(account.id)],
    ['refresh','Войти заново',()=>reauthorize(account.id)],
    ['trash','Удалить аккаунт',()=>deleteAccount(account.id)]
  ];
  for(const [glyph,label,action]of items){const button=node('button','menu-item',label);button.prepend(icon(glyph));button.setAttribute('role','menuitem');button.type='button';button.addEventListener('click',()=>{closeMenu();Promise.resolve(action()).catch(error=>toast(error.message,true));});menu.append(button);}
  menu.hidden=false;const rect=anchor.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(innerWidth-menu.offsetWidth-8,rect.right-menu.offsetWidth))}px`;menu.style.top=`${Math.max(8,Math.min(innerHeight-menu.offsetHeight-8,rect.bottom+5))}px`;menu.querySelector('button').focus();
}
async function runAccount(type,id,button) {
  if(button)button.disabled=true;
  try {await request({type,id,active:true});if(type==='switch'){await loadState();toast('Аккаунт выбран для обычных вкладок Steam.');}if(type==='refresh'){await loadState();toast('Профиль обновлён.');}}
  catch(error){toast(error.message,true);}finally{if(button)button.disabled=false;}
}
function addAccount() {
  editId=null;$('#account-form').reset();$('#account_name').readOnly=false;$('#password').required=true;$('#password').type='password';$('#password').placeholder='Пароль аккаунта Steam';$('#toggle-password').textContent='Показать';$('#account-form-title').textContent='Добавить аккаунт';$('#save').textContent='Войти в Steam';$('#account-form-error').hidden=true;$('#authenticator-fields').open=false;openDialog('#account-dialog');$('#account_name').focus();
}
async function editAccount(id) {
  const account=accountById(id);if(!account)return;
  $('#detail-dialog').close();addAccount();editId=id;$('#account-form-title').textContent='Редактировать аккаунт';$('#account_name').value=account.login;$('#account_name').readOnly=true;$('#password').required=false;$('#password').placeholder='Оставьте пустым, чтобы сохранить пароль';$('#save').textContent='Сохранить';$('#password').focus();
}
function showAuth(message) {
  const data=message.data;
  if(data.success){const wasOpen=$('#auth-dialog').open;$('#auth-dialog').close();$('#account-dialog').close();loadState().catch(error=>toast(error.message,true));if(wasOpen)toast('Вход в Steam выполнен.');return;}
  $('#account-dialog').close();$('#detail-dialog').close();openDialog('#auth-dialog');$('#auth-login').textContent=message.login || '';
  $('#auth-message').textContent=data.message || 'Подключение к Steam…';
  $('#auth-progress').hidden=!data.waiting;$('#auth-code-form').hidden=!data.type;$('#retry-auth').hidden=!!data.waiting || !!data.type;
  if(data.type){$('#auth-code').value='';$('#auth-code').focus();}
}
async function reauthorize(id) {
  const account=accountById(id);if(!account)return;
  if(!account.hasPassword)return editAccount(id);
  showAuth({login:account.login,data:{waiting:true,message:'Подключение к Steam…'}});
  request({type:'re_auth',id}).catch(error=>toast(error.message,true));
}
async function cancelAuth() {await request({type:'cancel'});$('#auth-dialog').close();}
function confirmAction(title,message,label='Подтвердить') {
  $('#confirm-title').textContent=title;$('#confirm-message').textContent=message;$('#confirm-yes').textContent=label;
  const dialog=openDialog('#confirm-dialog');
  return new Promise(resolve=>{dialog.addEventListener('close',()=>resolve(dialog.returnValue==='yes'),{once:true});dialog.returnValue='no';});
}
async function deleteAccount(id) {
  const account=accountById(id);if(!account)return;
  if(!await confirmAction(`Удалить ${account.login}?`,'Аккаунт удалится из расширения. Его отдельные вкладки Steam закроются.','Удалить'))return;
  await request({type:'del_acc',id});$('#detail-dialog').close();await loadState();toast('Аккаунт удалён.');
}
async function showDetails(id) {
  detail=await request({type:'account:details',id});bookmarkEditN=null;$('#bookmark-form').reset();$('#bookmark-error').hidden=true;
  $('#detail-name').textContent=detail.name || detail.login;$('#detail-login').textContent=detail.login;
  const image=avatar(detail);image.id='detail-avatar';$('#detail-avatar').replaceWith(image);
  $('#copy-steamid').textContent=detail.steamid;$('#detail-confirm').disabled=!detail.secret.identity;$('#detail-confirm').title=detail.secret.identity?'':'Добавьте identity_secret для подтверждений';
  renderBookmarks();openDialog('#detail-dialog');clearInterval(guardTimer);guardExpiresAt=0;$('#guard-code').textContent='—';$('#guard-time').textContent='';$('#guard-fill').style.width='0%';
  $('#copy-guard').disabled=true;$('#guard-help').textContent=detail.secret.shared?'Нажмите на код, чтобы скопировать.':'Добавьте shared_secret или импортируйте maFile, чтобы получать коды.';
  if(detail.secret.shared){await refreshGuard();guardTimer=setInterval(tickGuard,200);}
}
async function refreshGuard() {
  if(guardBusy || !detail || !$('#detail-dialog').open)return;
  guardBusy=true;const id=detail.id;
  try {const result=await request({type:'guard:code',id});if(detail?.id!==id || !$('#detail-dialog').open)return;$('#guard-code').textContent=result.code;$('#copy-guard').disabled=false;guardExpiresAt=result.expiresAt;tickGuard();}
  catch(error){$('#copy-guard').disabled=true;$('#guard-help').textContent=error.message;guardExpiresAt=Date.now()+5000;}
  finally{guardBusy=false;}
}
function tickGuard() {
  if(!$('#detail-dialog').open){clearInterval(guardTimer);return;}
  const remaining=Math.max(0,guardExpiresAt-Date.now());$('#guard-time').textContent=`${Math.ceil(remaining/1000)} с`;$('#guard-fill').style.width=`${Math.min(100,remaining/300)}%`;if(!remaining)refreshGuard();
}
function renderBookmarks() {
  const list=$('#bookmark-list');list.replaceChildren();
  if(!detail.urls.length)list.append(node('p','muted','Здесь будут ссылки этого аккаунта.'));
  for(const entry of detail.urls){
    const row=node('div','bookmark-row'),link=node('button','bookmark-link',entry.hostname + (new URL(entry.href).pathname==='/'?'':new URL(entry.href).pathname));link.title=entry.href;link.type='button';link.addEventListener('click',()=>request({type:'go_over',id:detail.id,link:entry.href,active:true}).catch(error=>toast(error.message,true)));
    const edit=node('button','icon-button');edit.append(icon('edit'));edit.type='button';edit.setAttribute('aria-label',`Редактировать ссылку ${entry.hostname}`);edit.addEventListener('click',()=>{bookmarkEditN=entry.n;$('#bookmark-url').value=entry.href;$('#bookmark-url').focus();});
    const clean=node('button','icon-button');clean.append(icon('refresh'));clean.type='button';clean.setAttribute('aria-label',`Очистить данные сайта ${entry.hostname}`);clean.title=`Очистить данные ${entry.hostname}`;
    clean.addEventListener('click',async()=>{try{if(!await confirmAction(`Очистить ${entry.hostname}?`,'Cookies и данные этого сайта для выбранного аккаунта будут удалены. Остальные аккаунты останутся на месте.','Очистить'))return;await request({type:'clean_db',id:detail.id,n:entry.n});toast('Данные сайта очищены.');}catch(error){toast(error.message,true);}});
    const remove=node('button','icon-button');remove.append(icon('trash'));remove.type='button';remove.setAttribute('aria-label',`Удалить ссылку ${entry.hostname}`);remove.addEventListener('click',async()=>{try{await request({type:'removeHref',id:detail.id,n:entry.n});detail=await request({type:'account:details',id:detail.id});renderBookmarks();}catch(error){toast(error.message,true);}});
    row.append(icon('link'),link,clean,edit,remove);list.append(row);
  }
}
async function copy(text) {try{await navigator.clipboard.writeText(text);toast('Скопировано.');}catch{toast('Не удалось скопировать. Откройте расширение в отдельной вкладке.',true);}}
async function updatePreview() {
  const token=++previewToken;$('#backup-error').hidden=true;$('#apply-import').disabled=true;
  if(!pendingBackup)return;
  try {
    const summary=await request({type:'backup:preview',backup:pendingBackup,overwrite:$('#overwrite-accounts').checked});if(token!==previewToken)return;
    $('#import-summary').textContent=`Добавить: ${summary.added}. Обновить: ${summary.updated}. Пропустить: ${summary.skipped}.`;
    $('#import-accounts').replaceChildren(...summary.accounts.map(account=>{const li=node('li');li.append(node('span',null,account.login),node('span',null,{add:'Добавить',update:'Обновить',skip:'Уже есть'}[account.action]));return li;}));
    const count=summary.added+summary.updated;$('#apply-import').textContent=count?`Импортировать ${plural(count)}`:'Нет новых аккаунтов';$('#apply-import').disabled=!count;$('#import-preview').hidden=false;
  }catch(error){if(token===previewToken){$('#import-preview').hidden=true;errorIn('#backup-error',error);}}
}
// Navigation and account list.
document.body.classList.toggle('tab-mode',document.documentElement.classList.contains('tab-mode'));
$('#expand').hidden=document.body.classList.contains('tab-mode');
$('#expand').addEventListener('click',()=>chrome.tabs.create({url:chrome.runtime.getURL('popup/popup.html?tab=1')}));
$('.brand').addEventListener('click',event=>{event.preventDefault();showView('accounts');});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>showView(button.dataset.view)));
$('#search_acc').addEventListener('input',render);$('#add-account').addEventListener('click',addAccount);$('#empty-add').addEventListener('click',addAccount);$('#empty-import').addEventListener('click',()=>{showView('backup');$('#choose-backup').click();});
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
$('#toggle-password').addEventListener('click',()=>{const show=$('#password').type==='password';$('#password').type=show?'text':'password';$('#toggle-password').textContent=show?'Скрыть':'Показать';});
$('#account-form').addEventListener('submit',async event=>{
  event.preventDefault();$('#account-form-error').hidden=true;
  const data={account_name:$('#account_name').value.trim()};
  for(const key of ['password','twofacode','shared_secret','identity_secret','device_id'])if($('#'+key).value)data[key]=$('#'+key).value;
  const type=editId?'edit_acc':'add_acc';$('#save').disabled=true;
  try {
    showAuth({login:data.account_name,data:{waiting:true,message:type==='add_acc'?'Подключение к Steam…':'Сохранение аккаунта…'}});
    await request({type,data});
  }catch(error){showAuth({login:data.account_name,data:{message:error.message}});}
  finally{$('#save').disabled=false;}
});
$('#import-mafile').addEventListener('click',()=>$('#mafile-input').click());
$('#mafile-input').addEventListener('change',async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  try {
    if(file.size>1024*1024)throw new Error('maFile слишком большой.');
    const data=JSON.parse(await file.text());
    if(typeof data.account_name!=='string')throw new Error('В maFile не найден account_name.');
    if(editId && data.account_name.toLowerCase()!==$('#account_name').value.toLowerCase())throw new Error('Этот maFile принадлежит другому аккаунту.');
    $('#account_name').value=data.account_name;
    for(const key of ['shared_secret','identity_secret','device_id'])if(typeof data[key]==='string')$('#'+key).value=data[key];
    $('#authenticator-fields').open=true;$('#account-form-error').hidden=true;$('#password').focus();
  }catch(error){errorIn('#account-form-error',error instanceof SyntaxError?new Error('Не удалось прочитать maFile: некорректный JSON.'):error);}
});
document.querySelectorAll('[data-cancel-auth]').forEach(button=>button.addEventListener('click',()=>cancelAuth().catch(error=>toast(error.message,true))));
$('#auth-dialog').addEventListener('cancel',event=>{event.preventDefault();cancelAuth().catch(error=>toast(error.message,true));});
$('#auth-code-form').addEventListener('submit',async event=>{event.preventDefault();const code=$('#auth-code').value.trim();$('#auth-code-form').hidden=true;$('#auth-progress').hidden=false;try{await request({type:'authCode',authCode:code});}catch(error){$('#auth-message').textContent=error.message;$('#retry-auth').hidden=false;$('#auth-progress').hidden=true;}});
$('#retry-auth').addEventListener('click',async()=>{$('#retry-auth').hidden=true;$('#auth-progress').hidden=false;try{await request({type:'authCode',authCode:''});}catch(error){$('#auth-message').textContent=error.message;$('#retry-auth').hidden=false;$('#auth-progress').hidden=true;}});
$('#detail-open').addEventListener('click',()=>runAccount('go_over',detail.id));$('#detail-switch').addEventListener('click',()=>runAccount('switch',detail.id));$('#detail-confirm').addEventListener('click',()=>runAccount('confirm',detail.id));$('#detail-edit').addEventListener('click',()=>editAccount(detail.id).catch(error=>toast(error.message,true)));$('#detail-reauth').addEventListener('click',()=>reauthorize(detail.id).catch(error=>toast(error.message,true)));$('#detail-refresh').addEventListener('click',async()=>{await runAccount('refresh',detail.id,$('#detail-refresh'));if($('#detail-dialog').open)await showDetails(detail.id);});
$('#copy-guard').addEventListener('click',()=>copy($('#guard-code').textContent));$('#copy-steamid').addEventListener('click',()=>copy(detail.steamid));$('#detail-dialog').addEventListener('close',()=>clearInterval(guardTimer));
$('#detail-delete').addEventListener('click',()=>deleteAccount(detail.id).catch(error=>toast(error.message,true)));
$('#detail-clear').addEventListener('click',async()=>{try{if(!await confirmAction(`Очистить сессию ${detail.login}?`,'Сохранённые cookies и данные сайтов будут удалены. Пароль и Steam Guard останутся. Для работы понадобится войти заново.','Очистить'))return;await request({type:'clear_data',id:detail.id});await loadState();toast('Сессия очищена.');}catch(error){toast(error.message,true);}});
$('#bookmark-form').addEventListener('submit',async event=>{event.preventDefault();$('#bookmark-error').hidden=true;try{const n=bookmarkEditN ?? Array.from({length:18},(_,i)=>i).find(i=>!detail.urls.some(entry=>entry.n===i));if(n===undefined)throw new Error('Можно сохранить до 18 ссылок.');const result=await request({type:'addHref',id:detail.id,n,href:$('#bookmark-url').value.trim()});if(!result)throw new Error('Укажите корректную ссылку http или https.');bookmarkEditN=null;$('#bookmark-form').reset();detail=await request({type:'account:details',id:detail.id});renderBookmarks();await loadState();}catch(error){errorIn('#bookmark-error',error);}});
$('#confirm-no').addEventListener('click',()=>$('#confirm-dialog').close('no'));$('#confirm-yes').addEventListener('click',()=>$('#confirm-dialog').close('yes'));
// JSON backups are created only in response to the user's explicit export click.
$('#export-accounts').addEventListener('click',async()=>{
  const button=$('#export-accounts');button.disabled=true;
  try {
    const backup=await request({type:'backup:export'}),blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`steam-user-manager-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
    toast(`Экспортировано: ${plural(backup.accounts.length)}.`);
  }catch(error){toast(error.message,true);}finally{button.disabled=!state.accounts.length;}
});
$('#choose-backup').addEventListener('click',()=>$('#backup-file').click());
$('#backup-file').addEventListener('change',async event=>{
  const file=event.target.files[0];event.target.value='';if(!file)return;
  pendingBackup=null;previewToken++;$('#apply-import').disabled=true;$('#import-preview').hidden=true;$('#backup-error').hidden=true;$('#backup-result').hidden=true;$('#overwrite-accounts').checked=false;
  try {if(file.size>20*1024*1024)throw new Error('Файл слишком большой. Максимальный размер — 20 МБ.');pendingBackup=JSON.parse(await file.text());$('#import-filename').textContent=file.name;await updatePreview();}
  catch(error){errorIn('#backup-error',error instanceof SyntaxError?new Error('Не удалось прочитать файл: некорректный JSON.'):error);}
});
$('#overwrite-accounts').addEventListener('change',updatePreview);
$('#apply-import').addEventListener('click',async()=>{
  if(!pendingBackup)return;const button=$('#apply-import');button.disabled=true;$('#choose-backup').disabled=true;$('#overwrite-accounts').disabled=true;$('#backup-error').hidden=true;
  try {const result=await request({type:'backup:import',backup:pendingBackup,overwrite:$('#overwrite-accounts').checked});await loadState();pendingBackup=null;$('#import-preview').hidden=true;$('#backup-result').textContent=`Готово. Добавлено: ${result.added}. Обновлено: ${result.updated}. Пропущено: ${result.skipped}.`;$('#backup-result').hidden=false;toast('Импорт аккаунтов завершён.');}
  catch(error){errorIn('#backup-error',error);button.disabled=false;}
  finally{$('#choose-backup').disabled=false;$('#overwrite-accounts').disabled=false;}
});
// Keyboard access and background updates.
document.addEventListener('click',event=>{if(!$('#account-menu').contains(event.target))closeMenu();});
$('#main').addEventListener('scroll',()=>closeMenu());
document.addEventListener('keydown',event=>{
  if(!$('#account-menu').hidden){const buttons=[...$('#account-menu').querySelectorAll('button')],index=buttons.indexOf(document.activeElement);if(event.key==='Escape'){event.preventDefault();closeMenu(true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}return;}
  if(event.key==='/' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')){event.preventDefault();showView('accounts');$('#search_acc').focus();}
});
chrome.runtime.onMessage.addListener(message=>{
  if(message.type==='auth')showAuth(message);
  if(message.type==='accounts:changed' || message.type==='active' || message.type==='refresh')loadState().catch(error=>toast(error.message,true));
  if(message.type==='sum:error')toast(message.message,true);
});
for(let i=0;i<3;i++){const row=node('div','skeleton-row');row.append(node('div','skeleton-avatar'),node('div','skeleton-text'));$('#accounts-list').append(row);}
Promise.all([loadState(),request({type:'getAuthState'})]).then(([,message])=>{if(message && !message.data.success)showAuth(message);}).catch(error=>{$('#account-count').textContent='Не удалось загрузить аккаунты';toast(error.message,true);});
