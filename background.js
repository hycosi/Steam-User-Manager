'use strict';
importScripts('core.js', 'backup.js', 'jsbn.js', 'rsa.js');
const C = SUMCore;
const steamPatterns = C.domains.map(domain => `https://*.${domain}/*`);
let accounts = {}, ids = {}, tabAccounts = {}, auth = null, lastAuth = null;
let activeBrowserAccount = null, offset = 0, activeRequest = null, changingBrowserCookies = false, retryAuth = null;
let requestQueue = Promise.resolve(), ruleQueue = Promise.resolve(), switchQueue = Promise.resolve();
let pollTimer, polling = false;
let backupQueue = Promise.resolve();
const requestOwners = new Map();
const notify = message => chrome.runtime.sendMessage(message).catch(() => {});
const save = () => chrome.storage.local.set({accounts, ids, activeBrowserAccount});
const saveSession = () => chrome.storage.session.set({tabAccounts, auth, lastAuth, offset, retryAuth});

function updateRules() {
  const run = async () => {
    const rules = [];
    for (const id of new Set(Object.values(tabAccounts))) {
      if (!accounts[id]) continue;
      const tabIds = Object.keys(tabAccounts).filter(tab => tabAccounts[tab] === id).map(Number);
      rules.push(...C.cookieRules(accounts[id].cookies, {tabIds}, rules.length + 1));
    }
    if (activeRequest && accounts[activeRequest]) {
      rules.push(...C.cookieRules(accounts[activeRequest].cookies,
        {tabIds: [-1], initiatorDomains: [chrome.runtime.id]}, rules.length + 1));
      rules.push({id: rules.length + 1, priority: 1, action: {type: 'modifyHeaders', requestHeaders: [
        {header: 'origin', operation: 'set', value: 'https://steamcommunity.com'},
        {header: 'referer', operation: 'set', value: 'https://steamcommunity.com/'}
      ]}, condition: {tabIds: [-1], initiatorDomains: [chrome.runtime.id], requestDomains: C.domains}});
    }
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: existing.map(rule => rule.id), addRules: rules});
  };
  const result = ruleQueue.then(run);
  ruleQueue = result.catch(error => console.error('Session rules:', error.message));
  return result;
}

const ready = (async () => {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  const [local, session, tabs] = await Promise.all([
    chrome.storage.local.get(['accounts', 'ids', 'activeBrowserAccount']),
    chrome.storage.session.get(['tabAccounts', 'auth', 'lastAuth', 'offset', 'retryAuth']), chrome.tabs.query({})
  ]);
  accounts = local.accounts || {};
  ids = local.ids || {};
  activeBrowserAccount = local.activeBrowserAccount || null;
  for (const [id, account] of Object.entries(accounts)) {
    account.cookies = (account.cookies || []).filter(cookie => C.live(cookie) &&
      C.domains.some(domain => C.domainMatches(cookie.domain.replace(/^\./, ''), domain)));
    account.urls ||= [];
    account.storage ||= {local: {}, session: {}};
    account.storage.local ||= {};
    account.storage.session ||= {};
    if (account.accountid) ids[account.accountid] = id;
  }
  for (const [accountid, id] of Object.entries(ids)) if (!accounts[id]) delete ids[accountid];
  tabAccounts = Object.fromEntries(Object.entries(session.tabAccounts || {})
    .filter(([tab, id]) => tabs.some(item => item.id === Number(tab)) && accounts[id]));
  auth = session.auth || null;
  retryAuth = session.retryAuth || null;
  lastAuth = session.lastAuth || null;
  offset = session.offset || 0;
  await updateRules();
  if (auth) schedulePoll();
})();

// Observers see the original response headers; DNR subsequently removes Set-Cookie
// so a managed tab cannot overwrite the browser's normal Steam session.
chrome.webRequest.onBeforeRequest.addListener(details => {
  const requestAccount = activeRequest;
  ready.then(() => {
    const owner = tabAccounts[details.tabId] ||
      (details.tabId === -1 && details.initiator === chrome.runtime.getURL('').slice(0, -1) ? requestAccount : null);
    if (owner) requestOwners.set(details.requestId, owner);
  });
}, {urls: steamPatterns});
chrome.webRequest.onHeadersReceived.addListener(details => {
  ready.then(() => {
  const owner = requestOwners.get(details.requestId) || tabAccounts[details.tabId];
  if (!owner || !accounts[owner]) return;
  let changed = false;
  for (const header of details.responseHeaders || []) {
    if (header.name.toLowerCase() === 'set-cookie') {
      changed = C.putCookie(accounts[owner].cookies, C.parseCookie(header.value, details.url)) || changed;
    }
  }
  if (changed) {
    save().catch(console.error);
    updateRules().catch(console.error);
    syncTabs(owner);
  }
  }).catch(console.error);
}, {urls: steamPatterns}, ['responseHeaders', 'extraHeaders']);
for (const event of [chrome.webRequest.onCompleted, chrome.webRequest.onErrorOccurred]) {
  event.addListener(details => requestOwners.delete(details.requestId), {urls: steamPatterns});
}

function steamRequest(id, value, body) {
  const run = async () => {
    if (!C.isSteamURL(value)) throw new Error('Refusing a request outside Steam.');
    activeRequest = id;
    try {
      await updateRules();
      const response = await fetch(value, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store',
        headers: body === undefined ? {} : {'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
        body: body === undefined ? undefined : new URLSearchParams(body).toString(),
        signal: AbortSignal.timeout(25000)
      });
      const text = await response.text();
      await ruleQueue;
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      const result = response.headers.get('x-eresult');
      if (!response.ok || (result && result !== '1')) {
        const endpoint = new URL(value).pathname.replace(/\/$/, '');
        throw new Error(typeof data === 'object' && (data.message || data.response?.extended_error_message) ||
          `Steam ${endpoint} failed (HTTP ${response.status}${result ? `, EResult ${result}` : ''}).`);
      }
      return data;
    } finally {
      activeRequest = null;
      await updateRules();
    }
  };
  const result = requestQueue.then(run);
  requestQueue = result.catch(() => {});
  return result;
}
const api = async (method, params, get = false) => {
  const url = `https://api.steampowered.com/IAuthenticationService/${method}/v1/`;
  // Steam's service API expects structured messages. Passing device_details as
  // an ordinary form string produces HTTP 400 before credentials are evaluated.
  const input = {input_json: JSON.stringify(params)};
  const data = await steamRequest(auth?.id || null, get ? `${url}?${new URLSearchParams(input)}` : url,
    get ? undefined : input);
  if (!data || typeof data !== 'object' || !data.response) throw new Error('Unexpected response from Steam authentication.');
  return data.response;
};
async function syncTime() {
  const data = await steamRequest(null, 'https://api.steampowered.com/ITwoFactorService/QueryTime/v1/', {});
  if (data?.response?.server_time) {
    offset = Number(data.response.server_time) - Date.now() / 1000;
    await saveSession();
  }
}
const steamTime = () => Math.floor(Date.now() / 1000 + offset);

function syncTabs(id) {
  for (const [tab, owner] of Object.entries(tabAccounts)) if (owner === id) {
    chrome.tabs.sendMessage(Number(tab), {type: 'sum:refresh'}).catch(() => {});
  }
}
async function openAccountTab(id, url = 'https://steamcommunity.com/my/', active = true) {
  if (!accounts[id]) throw new Error('Account not found.');
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid bookmark URL.');
  // Bind and install rules BEFORE the first network request.
  const tab = await chrome.tabs.create({url: 'about:blank', active});
  if (C.isSteamURL(url)) {
    tabAccounts[tab.id] = id;
    try { await saveSession(); await updateRules(); }
    catch (error) { delete tabAccounts[tab.id]; await chrome.tabs.remove(tab.id); throw error; }
  }
  await chrome.tabs.update(tab.id, {url});
  return tab;
}
chrome.tabs.onRemoved.addListener(tabId => {
  ready.then(async () => {
    const account = accounts[tabAccounts[tabId]];
    if (account) {
      for (const key of Object.keys(account.storage.session)) if (key.startsWith(`${tabId}:`)) delete account.storage.session[key];
      await save();
    }
    delete tabAccounts[tabId]; await saveSession(); await updateRules();
  }).catch(console.error);
});
chrome.tabs.onCreated.addListener(tab => {
  if (tab.openerTabId == null) return;
  ready.then(async () => {
    const id = tabAccounts[tab.openerTabId];
    if (id && (!tab.pendingUrl || C.isSteamURL(tab.pendingUrl) || tab.pendingUrl === 'about:blank')) {
      tabAccounts[tab.id] = id;
      await saveSession();
      await updateRules();
    }
  }).catch(console.error);
});
chrome.cookies.onChanged.addListener(change => {
  ready.then(async () => {
    if (changingBrowserCookies || !accounts[activeBrowserAccount]) return;
    const cookie = change.cookie;
    if (!C.domains.some(domain => C.domainMatches(cookie.domain.replace(/^\./, ''), domain))) return;
    C.putCookie(accounts[activeBrowserAccount].cookies,
      change.removed ? {...cookie, session: false, expirationDate: 0} : cookie);
    await save(); await updateRules(); syncTabs(activeBrowserAccount);
  }).catch(console.error);
});
async function browserCookies() {
  return (await Promise.all(C.domains.map(domain => chrome.cookies.getAll({domain})))).flat();
}
function switchBrowser(id) {
  const run = async () => {
    if (!accounts[id]) throw new Error('Account not found.');
    const previous = await browserCookies();
    const previousOwner = activeBrowserAccount;
    if (previousOwner !== id && accounts[previousOwner]) accounts[previousOwner].cookies = previous;
    changingBrowserCookies = true;
    async function removeCookies(items) {
      for (const cookie of items) await chrome.cookies.remove({
        url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`, name: cookie.name,
        storeId: cookie.storeId, ...(cookie.partitionKey ? {partitionKey: cookie.partitionKey} : {})
      });
    }
    async function setCookies(items) {
      for (const cookie of items.filter(C.live)) {
        const details = {url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
          name: cookie.name, value: cookie.value, path: cookie.path, secure: cookie.secure,
          httpOnly: cookie.httpOnly, sameSite: cookie.sameSite || 'unspecified'};
        if (!cookie.hostOnly) details.domain = cookie.domain;
        if (!cookie.session && cookie.expirationDate) details.expirationDate = cookie.expirationDate;
        if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
        const result = await chrome.cookies.set(details);
        if (!result) throw new Error('Unable to install Steam cookies.');
      }
    }
    try {
      await removeCookies(previous);
      await setCookies(accounts[id].cookies);
      activeBrowserAccount = id;
      await save();
    } catch (error) {
      await removeCookies(await browserCookies());
      await setCookies(previous);
      activeBrowserAccount = previousOwner;
      await save();
      throw error;
    } finally { changingBrowserCookies = false; }
    await notify({type: 'active', id: accounts[id].accountid});
    for (const tab of await chrome.tabs.query({url: steamPatterns})) {
      if (!tabAccounts[tab.id]) await chrome.tabs.reload(tab.id);
    }
  };
  const result = switchQueue.then(run);
  switchQueue = result.catch(() => {});
  return result;
}

async function authStatus(data, login = auth?.account?.login) {
  lastAuth = {type: 'auth', login, data};
  await saveSession();
  await notify(lastAuth);
}
function schedulePoll() {
  clearTimeout(pollTimer);
  if (!auth?.client_id) return;
  chrome.alarms.create('sum-auth', {delayInMinutes: 0.5}).catch(console.error);
  pollTimer = setTimeout(() => pollAuth().catch(authError), Math.max(1000, (auth.interval || 5) * 1000));
}
async function cancelAuth() {
  clearTimeout(pollTimer);
  await chrome.alarms.clear('sum-auth');
  auth = null;
  retryAuth = null;
  lastAuth = null;
  await saveSession();
}
async function authError(error) {
  const login = auth?.account?.login;
  if (!login) return;
  const retry = {id: auth.id, account: auth.account};
  await cancelAuth();
  retryAuth = retry;
  await authStatus({success: false, message: error.message || 'Steam authentication failed.'}, login);
}
async function beginAuth(id, account, code) {
  await cancelAuth();
  auth = {id, account: structuredClone(account), started: Date.now(), generation: crypto.randomUUID()};
  await saveSession();
  await authStatus({success: false, waiting: true, message: 'Connecting to Steam…'});
  const current = auth;
  try {
    await syncTime().catch(() => {});
    const key = await api('GetPasswordRSAPublicKey', {account_name: account.login}, true);
    if (auth !== current) return;
    const encrypted = RSA.encrypt(account.password, RSA.getPublicKey(key.publickey_mod, key.publickey_exp));
    if (!encrypted) throw new Error('Unable to encrypt the Steam password.');
    const details = {device_friendly_name: 'Steam User Manager', platform_type: 2};
    const response = await api('BeginAuthSessionViaCredentials', {
      account_name: account.login, encrypted_password: encrypted, encryption_timestamp: key.timestamp,
      remember_login: true, persistence: 1, website_id: 'Community',
      device_details: details
    });
    if (auth !== current) return;
    if (!response.client_id || !response.request_id || !response.steamid) {
      throw new Error(response.extended_error_message || 'Steam did not return a login session.');
    }
    Object.assign(auth, {client_id: response.client_id, request_id: response.request_id,
      steamid: response.steamid, interval: response.interval || 5, guards: response.allowed_confirmations || []});
    const guards = auth.guards.map(item => item.confirmation_type);
    auth.code_type = guards.includes(3) ? 3 : guards.includes(2) ? 2 : null;
    await saveSession();
    if (auth.code_type && (code || (auth.code_type === 3 && account.shared_secret))) {
      await submitCode(code || await C.authCode(account.shared_secret, steamTime()));
    } else if (auth.code_type) {
      await authStatus({success: false, type: auth.code_type === 3 ? 2 : 1,
        message: auth.code_type === 3 ? 'Enter Steam Guard code, or approve this login in the Steam mobile app.' : 'Enter the code sent by Steam to your email.'});
    } else if (guards.includes(4) || guards.includes(5)) {
      await authStatus({success: false, waiting: true, message: 'Approve this login in the Steam mobile app or your email.'});
    } else if (!guards.includes(1) && guards.length) {
      throw new Error('This Steam login confirmation method is not supported.');
    }
    schedulePoll();
    await pollAuth();
  } catch (error) { if (auth === current) await authError(error); }
}
async function submitCode(code) {
  if (!auth?.client_id || !auth.code_type) throw new Error('Start a Steam login first.');
  const current = auth;
  if (!/^[a-z0-9]{5,7}$/i.test(code)) throw new Error('Enter a valid Steam Guard code.');
  await api('UpdateAuthSessionWithSteamGuardCode', {client_id: auth.client_id,
    steamid: auth.steamid, code: code.trim(), code_type: auth.code_type});
  if (auth !== current) return;
  await authStatus({success: false, waiting: true, message: 'Waiting for Steam to complete the login…'});
  schedulePoll();
}
async function pollAuth() {
  await ready;
  if (!auth?.client_id || polling) return;
  polling = true;
  const current = auth;
  try {
    if (Date.now() - current.started > 5 * 60 * 1000) throw new Error('Steam login timed out. Try again.');
    const response = await api('PollAuthSessionStatus', {client_id: current.client_id, request_id: current.request_id});
    if (auth !== current) return;
    if (response.new_client_id) current.client_id = response.new_client_id;
    if (response.refresh_token) await finishAuth(current, response.refresh_token);
    else { await saveSession(); schedulePoll(); }
  } catch (error) {
    if (auth === current) await authError(error);
  } finally { polling = false; }
}
async function finishAuth(current, refreshToken) {
  const account = current.account;
  const id = current.id;
  // A temporary jar also allows adding an account without touching the browser's cookies.
  const previous = accounts[id];
  accounts[id] = account;
  const sessionid = Array.from(crypto.getRandomValues(new Uint8Array(12)), n => n.toString(16).padStart(2, '0')).join('');
  try {
    const data = await steamRequest(id, 'https://login.steampowered.com/jwt/finalizelogin', {
      nonce: refreshToken, sessionid, redir: 'https://steamcommunity.com/login/home/?goto='
    });
    if (!Array.isArray(data.transfer_info) || !data.transfer_info.length) throw new Error('Steam did not return web login transfers.');
    for (const transfer of data.transfer_info) {
      if (!C.isSteamURL(transfer.url) || !new URL(transfer.url).pathname.startsWith('/login/')) throw new Error('Unexpected Steam login transfer URL.');
      const result = await steamRequest(id, transfer.url, {...transfer.params, steamID: data.steamID || current.steamid});
      if (result?.result && Number(result.result) !== 1) throw new Error('Steam web login transfer failed.');
    }
    if (auth !== current) {
      if (previous) accounts[id] = previous; else delete accounts[id];
      await save(); await updateRules(); return;
    }
    if (!account.cookies.some(cookie => cookie.name === 'steamLoginSecure' && C.domainMatches('steamcommunity.com', cookie.domain, cookie.hostOnly))) {
      throw new Error('Steam did not provide a Community session cookie.');
    }
    account.steamid = String(current.steamid);
    account.accountid = String(BigInt(account.steamid) - 76561197960265728n);
    account.device_id ||= `android:${(await C.sha1(account.steamid)).slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}`;
    for (const domain of ['steamcommunity.com', 'steampowered.com', 'steam.tv']) {
      C.putCookie(account.cookies, C.parseCookie(`sessionid=${sessionid}; Path=/; Secure; Domain=${domain}`, `https://${domain}/`));
    }
    ids[account.accountid] = id;
    await save(); await updateRules();
    const login = account.login;
    await cancelAuth();
    await authStatus({success: true}, login);
    await updateProfile(id).catch(() => {});
  } catch (error) {
    if (previous) accounts[id] = previous; else delete accounts[id];
    await save(); await updateRules();
    throw error;
  }
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'sum-auth') ready.then(pollAuth).catch(authError);
});
async function updateProfile(id) {
  const account = accounts[id];
  if (!account?.accountid) return null;
  const data = await steamRequest(id, `https://steamcommunity.com/miniprofile/${account.accountid}/json`);
  if (!data?.avatar_url) return null;
  const profile = {avatar: data.avatar_url, name: data.persona_name, level: data.level};
  if (data.avatar_frame) profile.frame = data.avatar_frame;
  const video = data.profile_background?.['video/webm'] || data.profile_background?.['video/mp4'];
  if (video) profile.video = video;
  delete account.video; delete account.frame;
  Object.assign(account, profile);
  await save(); await notify({type: 'refresh', id: account.accountid, data: profile});
  return profile;
}
async function confirmationParams(account, tag) {
  if (!account?.identity_secret || !account.steamid || !account.device_id) throw new Error('Import identity_secret and device_id for this account first.');
  const t = steamTime();
  return {p: account.device_id, a: account.steamid, k: await C.confirmationKey(account.identity_secret, t, tag), t, m: 'android', tag};
}
async function confirmationRequest(id, operation, item) {
  const account = accounts[id];
  await syncTime().catch(() => {});
  const params = await confirmationParams(account, operation === 'list' ? 'conf' : operation);
  if (operation !== 'list') {
    if (!item || !/^\d+$/.test(item.id) || !/^\d+$/.test(item.nonce)) throw new Error('Invalid confirmation.');
    Object.assign(params, {op: operation, cid: item.id, ck: item.nonce});
  }
  const path = operation === 'list' ? 'getlist' : 'ajaxop';
  const result = await steamRequest(id, `https://steamcommunity.com/mobileconf/${path}?${new URLSearchParams(params)}`);
  if (!result?.success) throw new Error(result?.needauth ? 'Steam session expired. Reauthorize this account.' : result?.message || 'Steam confirmation request failed.');
  return result;
}

function publicAccount(id) {
  const account = accounts[ids[id]];
  return {id, login: account.login, name: account.name, avatar: account.avatar, level: account.level,
    ...(account.frame ? {frame: account.frame} : {}), ...(account.video ? {video: account.video} : {}),
    tabs: account.urls.map(url => url.n), hasPassword: !!account.password,
    hasSession: account.cookies.some(cookie => cookie.name === 'steamLoginSecure' && C.live(cookie)),
    secret: {identity: !!account.identity_secret, shared: !!account.shared_secret}};
}
function importBackup(document, overwrite) {
  const run = async () => {
    const incoming = await SUMBackup.read(document);
    if (auth) throw new Error('Завершите текущий вход в Steam перед импортом.');
    const plan = SUMBackup.plan(incoming, accounts, overwrite);
    const nextAccounts = {...accounts}, nextIds = {...ids}, updatedIds = [];
    for (const item of plan.entries) {
      if (item.action === 'skip') continue;
      const id = item.existingId || await C.sha1(item.account.login);
      if (nextAccounts[id] && !item.existingId) throw new Error('Конфликт ID аккаунта. Импорт отменён.');
      nextAccounts[id] = item.account;
      nextIds[item.account.accountid] = id;
      if (item.action === 'update') updatedIds.push(id);
    }
    const previous = {accounts, ids, activeBrowserAccount};
    accounts = nextAccounts; ids = nextIds;
    // Import only changes extension data. The global browser cookie jar is not replaced.
    if (updatedIds.includes(activeBrowserAccount)) activeBrowserAccount = null;
    try { await updateRules(); await save(); }
    catch (error) {
      ({accounts, ids, activeBrowserAccount} = previous);
      await updateRules();
      throw error;
    }
    for (const id of updatedIds) syncTabs(id);
    await notify({type: 'accounts:changed'});
    return plan.summary;
  };
  const result = backupQueue.then(run);
  backupQueue = result.catch(() => {});
  return result;
}
function tabState(sender) {
  const id = tabAccounts[sender.tab?.id], account = accounts[id];
  if (!account || !C.isSteamURL(sender.url)) return null;
  const origin = new URL(sender.url).origin;
  return {cookies: C.cookiesFor(account.cookies, sender.url, true),
    localStorage: account.storage.local[origin] || {},
    sessionStorage: account.storage.session[`${sender.tab.id}:${origin}`] || {}};
}
async function handlePage(message, sender) {
  const state = tabState(sender);
  if (!state) return null;
  const id = tabAccounts[sender.tab.id], account = accounts[id], origin = new URL(sender.url).origin;
  if (message.type === 'sum:init') return state;
  if (message.type === 'sum:open') {
    if (!C.isSteamURL(message.url)) return null;
    return {tabId: (await openAccountTab(id, message.url, message.active !== false)).id};
  }
  if (message.type === 'sum:cookie' && typeof message.value === 'string' && message.value.length < 8192) {
    C.putCookie(account.cookies, C.parseCookie(message.value, sender.url, true), true);
    await save(); await updateRules(); syncTabs(id);
    return tabState(sender);
  }
  if (message.type === 'sum:storage' && ['localStorage', 'sessionStorage'].includes(message.storage)) {
    const bucket = account.storage[message.storage === 'localStorage' ? 'local' : 'session'];
    const key = message.storage === 'localStorage' ? origin : `${sender.tab.id}:${origin}`;
    const values = Object.assign(Object.create(null), bucket[key] || {});
    if (message.event === 'clear') bucket[key] = {};
    else if (typeof message.key === 'string' && message.key.length < 8192) {
      if (message.event === 'removeItem') delete values[message.key];
      else if (message.event === 'setItem' && typeof message.value === 'string') values[message.key] = message.value;
      if (JSON.stringify(values).length > 5 * 1024 * 1024) throw new Error('Account storage quota exceeded.');
      bucket[key] = values;
    }
    await save(); syncTabs(id);
  }
  return null;
}
async function handleMessage(message, sender) {
  await ready;
  const trusted = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  if (!trusted) return handlePage(message, sender);
  if (message === 'getAccs') return Object.keys(ids).map(publicAccount);
  if (message.type === 'ui:state') return {
    accounts: Object.keys(ids).map(publicAccount), activeId: accounts[activeBrowserAccount]?.accountid || null,
    version: chrome.runtime.getManifest().version
  };
  if (message.type === 'backup:export') return SUMBackup.create(accounts, chrome.runtime.getManifest().version);
  if (message.type === 'backup:preview') {
    const incoming = await SUMBackup.read(message.backup);
    return SUMBackup.plan(incoming, accounts, message.overwrite === true).summary;
  }
  if (message.type === 'backup:import') return importBackup(message.backup, message.overwrite === true);
  if (message === 'getTabs') return Object.fromEntries(Object.keys(ids).map(id => [id,
    Object.fromEntries(accounts[ids[id]].urls.map(url => [url.n, {link: url.href, favicon: chrome.runtime.getURL('popup/svg/link.svg')}]))]));
  if (message.type === 'getAuthState') return lastAuth;
  if (message.type === 'cancel') { await cancelAuth(); return true; }
  if (message.type === 'authCode') {
    if (!auth) {
      if (retryAuth) { await beginAuth(retryAuth.id, retryAuth.account); return true; }
      throw new Error('Login expired. Reauthorize the account.');
    }
    try { await submitCode(message.authCode || ''); await pollAuth(); }
    catch (error) { await authStatus({success: false, type: auth?.code_type === 3 ? 2 : 1, message: error.message}); }
    return true;
  }
  if (message.type === 'add_acc' || message.type === 'edit_acc') {
    const details = message.data;
    const login = String(details.account_name || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{1,64}$/.test(login)) throw new Error('Invalid Steam account name.');
    const existingId = Object.keys(accounts).find(key => accounts[key].login === login);
    if (message.type === 'add_acc' && existingId && accounts[existingId].accountid) throw new Error('This account has already been added.');
    if (message.type === 'edit_acc' && !existingId) throw new Error('Account not found.');
    const id = existingId || await C.sha1(login);
    const account = structuredClone(accounts[id] || {login, cookies: [], urls: [], storage: {local: {}, session: {}}});
    for (const key of ['shared_secret', 'identity_secret', 'device_id']) if (key in details) account[key] = details[key] || null;
    for (const secret of [account.shared_secret, account.identity_secret]) if (secret) C.secretBytes(secret);
    if (account.device_id && !/^android:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(account.device_id)) throw new Error('Invalid Steam device ID.');
    account.password = details.password || account.password;
    if (!account.password) throw new Error('Enter a Steam password.');
    if (message.type === 'edit_acc' && !details.password && !details.twofacode && details.shared_secret === undefined) {
      accounts[id] = account; await save(); await authStatus({success: true}, login);
    } else {
      // Persist the pending login, not a partially added account.
      await beginAuth(id, account, details.twofacode);
    }
    return true;
  }
  const id = ids[message.id], account = accounts[id];
  if (!account) throw new Error('Account not found.');
  switch (message.type) {
    case 'account:details': return {...publicAccount(message.id), steamid: account.steamid, urls: structuredClone(account.urls)};
    case 'guard:code': {
      if (!account.shared_secret) throw new Error('Добавьте shared_secret или импортируйте maFile этого аккаунта.');
      await syncTime().catch(() => {});
      const now = Date.now() / 1000 + offset;
      return {code: await C.authCode(account.shared_secret, now), expiresAt: Date.now() + (30 - now % 30) * 1000};
    }
    case 'go_over':
      await openAccountTab(id, message.link || 'https://steamcommunity.com/my/', message.active !== false); return true;
    case 'switch': await switchBrowser(id); return true;
    case 'refresh': return updateProfile(id);
    case 're_auth': await beginAuth(id, account); return true;
    case 'getCode': {
      await syncTime().catch(() => {});
      const code = await C.authCode(account.shared_secret, steamTime());
      await notify({type: 'twofactorcode', code}); return code;
    }
    case 'confirm':
      await chrome.windows.create({url: chrome.runtime.getURL(`mobileconf.html?id=${encodeURIComponent(message.id)}`), type: 'popup', width: 580, height: 760}); return true;
    case 'confirm:list': return {login: account.login, ...(await confirmationRequest(id, 'list'))};
    case 'confirm:act':
      if (!['allow', 'cancel'].includes(message.operation)) throw new Error('Invalid confirmation operation.');
      return confirmationRequest(id, message.operation, message.item);
    case 'addHref': {
      const url = new URL(message.href);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
      if (!Number.isInteger(Number(message.n)) || Number(message.n) < 0 || Number(message.n) > 17) return false;
      account.urls = account.urls.filter(item => item.n != message.n && item.href !== url.href);
      account.urls.push({href: url.href, hostname: url.hostname, n: Number(message.n)});
      await save(); return true;
    }
    case 'removeHref': account.urls = account.urls.filter(item => item.n != message.n); await save(); return true;
    case 'clean_db': {
      const url = new URL(account.urls.find(item => item.n == message.n).href);
      delete account.storage.local[url.origin];
      for (const key of Object.keys(account.storage.session)) if (key.endsWith(`:${url.origin}`)) delete account.storage.session[key];
      account.cookies = account.cookies.filter(cookie => !C.domainMatches(url.hostname, cookie.domain, cookie.hostOnly));
      await save(); await updateRules(); syncTabs(id); return true;
    }
    case 'clear_data':
      account.cookies = []; account.storage = {local: {}, session: {}};
      await save(); await updateRules(); syncTabs(id); return true;
    case 'del_acc':
      // Close managed tabs before releasing their cookie isolation.
      for (const [tab, owner] of Object.entries(tabAccounts)) if (owner === id) {
        await chrome.tabs.remove(Number(tab)).catch(() => {}); delete tabAccounts[tab];
      }
      delete accounts[id]; delete ids[message.id];
      if (activeBrowserAccount === id) activeBrowserAccount = null;
      if (auth?.id === id) await cancelAuth();
      await save(); await saveSession(); await updateRules(); return true;
    default: throw new Error('Unknown extension command.');
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Extension notifications are consumed by UI pages, not treated as commands.
  if (['auth', 'active', 'twofactorcode', 'accounts:changed'].includes(message?.type) ||
      (message?.type === 'refresh' && message.data !== undefined)) return;
  handleMessage(message, sender).then(respond).catch(async error => {
    if (sender.url?.startsWith(chrome.runtime.getURL(''))) {
      if (['add_acc', 'edit_acc', 're_auth'].includes(message?.type)) {
        await authStatus({success: false, message: error.message}, message.data?.account_name || accounts[ids[message.id]]?.login);
      } else await notify({type: 'sum:error', message: error.message});
    }
    respond({error: error.message});
  });
  return true;
});
