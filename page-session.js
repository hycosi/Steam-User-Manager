/* Packaged MAIN-world content script: no inline scripts, eval or remote code. */
(() => {
  'use strict';
  const C = globalThis.SUMCore;
  let installed = false, jar = [], stores, managed = null;
  const pending = [];
  const startupWrites = [];
  const originalCookie = Object.getOwnPropertyDescriptor(document, 'cookie');
  const originalStorage = Object.fromEntries(['localStorage', 'sessionStorage'].map(name =>
    [name, {descriptor: Object.getOwnPropertyDescriptor(window, name), value: window[name]}]));
  const send = payload => {
    if (managed === null && payload.type !== 'sum:ready') { startupWrites.push(payload); return; }
    if (managed !== false) window.postMessage({channel: 'SUM:page', payload}, location.origin);
  };
  function storageProxy(name, initial) {
    const values = Object.assign(Object.create(null), initial);
    const change = (event, key, value) => {
      const payload = {type: 'sum:storage', storage: name, event, key, value};
      pending.push(payload);
      send(payload);
    };
    const write = (key, value) => {
      key = String(key); value = String(value);
      const copy = {...values, [key]: value};
      if (JSON.stringify(copy).length > 5 * 1024 * 1024) throw new DOMException('Account storage quota exceeded.', 'QuotaExceededError');
      values[key] = value;
      change('setItem', key, value);
    };
    const methods = {
      getItem: key => Object.hasOwn(values, String(key)) ? values[String(key)] : null,
      setItem: write,
      removeItem: key => { key = String(key); delete values[key]; change('removeItem', key); },
      clear: () => { for (const key of Object.keys(values)) delete values[key]; change('clear'); },
      key: index => Object.keys(values)[Number(index) >>> 0] ?? null
    };
    const proxy = new Proxy(values, {
      get: (target, key) => key === 'length' ? Object.keys(values).length :
        key === Symbol.toStringTag ? 'Storage' : Object.hasOwn(methods, key) ? methods[key] : target[key],
      set: (target, key, value) => { write(key, value); return true; },
      deleteProperty: (target, key) => { methods.removeItem(key); return true; },
      defineProperty: (target, key, descriptor) => {
        if ('value' in descriptor) write(key, descriptor.value);
        return true;
      }
    });
    Object.defineProperty(window, name, {configurable: true, get: () => proxy});
    return values;
  }
  function apply(snapshot) {
    jar = snapshot.cookies || [];
    if (!installed) {
      installed = true;
      stores = {
        localStorage: storageProxy('localStorage', snapshot.localStorage),
        sessionStorage: storageProxy('sessionStorage', snapshot.sessionStorage)
      };
      Object.defineProperty(document, 'cookie', {configurable: true,
        get: () => C.cookiesFor(jar, location.href, true).map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
        set: value => {
          const cookie = C.parseCookie(String(value), location.href, true);
          if (C.putCookie(jar, cookie, true)) send({type: 'sum:cookie', value: String(value)});
        }
      });
      // Install before native new-tab navigation to prevent an unbound first request.
      const navigate = event => {
        if (managed !== true) return;
        if (event.defaultPrevented || event.altKey || (event.type === 'auxclick' && event.button !== 1)) return;
        const anchor = event.target.closest?.('a[href]');
        if (!anchor || !C.isSteamURL(anchor.href)) return;
        if (event.button === 1 || event.ctrlKey || event.metaKey || anchor.target === '_blank') {
          event.preventDefault();
          send({type: 'sum:open', url: anchor.href, active: event.shiftKey || anchor.target === '_blank'});
        }
      };
      document.addEventListener('click', navigate);
      document.addEventListener('auxclick', navigate);
    } else {
      for (const name of Object.keys(stores)) {
        for (const key of Object.keys(stores[name])) delete stores[name][key];
        Object.assign(stores[name], snapshot[name]);
      }
      // A response to an earlier write must not hide a later local write.
      for (const item of pending) {
        const values = stores[item.storage];
        if (item.event === 'clear') for (const key of Object.keys(values)) delete values[key];
        if (item.event === 'setItem') values[item.key] = item.value;
        if (item.event === 'removeItem') delete values[item.key];
      }
    }
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'SUM:extension') return;
    const {snapshot, ack} = event.data;
    if (ack) pending.shift();
    if (snapshot) {
      managed = true;
      apply(snapshot);
      for (const item of startupWrites.splice(0)) {
        if (item.type === 'sum:cookie') C.putCookie(jar, C.parseCookie(item.value, location.href, true), true);
        send(item);
      }
    } else if (managed === null) {
      // Ordinary Steam tabs retain their native storage after the worker identifies them.
      managed = false;
      if (originalCookie) Object.defineProperty(document, 'cookie', originalCookie);
      else delete document.cookie;
      for (const [name, original] of Object.entries(originalStorage)) Object.defineProperty(window, name, original.descriptor);
      for (const item of startupWrites.splice(0)) {
        if (item.type === 'sum:cookie') document.cookie = item.value;
        if (item.type === 'sum:storage') {
          const native = originalStorage[item.storage].value;
          if (item.event === 'setItem') native.setItem(item.key, item.value);
          if (item.event === 'removeItem') native.removeItem(item.key);
          if (item.event === 'clear') native.clear();
        }
      }
      pending.length = 0;
    }
  });
  // Fail closed during the asynchronous handshake: a page must never read another
  // account's browser cookies/storage before its own snapshot arrives.
  apply({cookies: [], localStorage: {}, sessionStorage: {}});
  send({type: 'sum:ready'});
})();
