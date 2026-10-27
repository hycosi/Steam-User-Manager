/* Shared by the worker, packaged MAIN-world script and Node tests. */
(() => {
  'use strict';
  const domains = ['steamcommunity.com', 'steampowered.com', 'steam.tv'];
  const domainMatches = (host, domain, hostOnly = false) => {
    domain = domain.replace(/^\./, '').toLowerCase();
    host = host.toLowerCase();
    return host === domain || (!hostOnly && host.endsWith(`.${domain}`));
  };
  const isSteamURL = value => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && (!url.port || url.port === '443') &&
        !url.username && !url.password && domains.some(domain => domainMatches(url.hostname, domain));
    } catch { return false; }
  };
  const pathMatches = (path, cookiePath) => path === cookiePath ||
    (path.startsWith(cookiePath) && (cookiePath.endsWith('/') || path[cookiePath.length] === '/'));
  const live = cookie => cookie.session || cookie.expirationDate > Date.now() / 1000;
  function cookiesFor(cookies, value, js = false) {
    const url = new URL(value);
    return cookies.filter(cookie => live(cookie) &&
      domainMatches(url.hostname, cookie.domain, cookie.hostOnly) &&
      pathMatches(url.pathname, cookie.path || '/') &&
      (!cookie.secure || url.protocol === 'https:') && (!js || !cookie.httpOnly))
      .sort((a, b) => b.path.length - a.path.length);
  }
  function parseCookie(value, source, js = false, now = Date.now() / 1000) {
    const url = new URL(source);
    const [pair, ...parts] = String(value).split(';');
    const equals = pair.indexOf('=');
    if (equals <= 0) return null;
    const name = pair.slice(0, equals).trim(), content = pair.slice(equals + 1).trim();
    if (/[\s\x00-\x1f\x7f()<>@,;:\\"/\[\]?={}]/.test(name) || /[\x00-\x1f\x7f;]/.test(content)) return null;
    const attributes = Object.create(null);
    for (const part of parts) {
      const index = part.indexOf('=');
      attributes[(index < 0 ? part : part.slice(0, index)).trim().toLowerCase()] =
        index < 0 ? true : part.slice(index + 1).trim();
    }
    const domain = String(attributes.domain || url.hostname).replace(/^\./, '').toLowerCase();
    if (!domains.some(base => domainMatches(domain, base)) || !domainMatches(url.hostname, domain)) return null;
    const secure = 'secure' in attributes, httpOnly = 'httponly' in attributes;
    if ((js && httpOnly) || (secure && url.protocol !== 'https:')) return null;
    const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
    const path = typeof attributes.path === 'string' && attributes.path.startsWith('/') ? attributes.path : defaultPath;
    const sameSite = /^none$/i.test(attributes.samesite) ? 'no_restriction' :
      /^strict$/i.test(attributes.samesite) ? 'strict' : /^lax$/i.test(attributes.samesite) ? 'lax' : 'unspecified';
    if (sameSite === 'no_restriction' && !secure) return null;
    if (name.startsWith('__Secure-') && !secure) return null;
    if (name.startsWith('__Host-') && (!secure || attributes.domain || path !== '/')) return null;
    const cookie = {name, value: content, domain: attributes.domain ? `.${domain}` : domain,
      hostOnly: !attributes.domain, path, secure, httpOnly, sameSite, session: true};
    if (typeof attributes.expires === 'string' && Number.isFinite(Date.parse(attributes.expires))) {
      cookie.expirationDate = Date.parse(attributes.expires) / 1000;
      cookie.session = false;
    }
    if (typeof attributes['max-age'] === 'string' && /^-?\d+$/.test(attributes['max-age'])) {
      cookie.expirationDate = now + Number(attributes['max-age']);
      cookie.session = false;
    }
    return cookie;
  }
  function putCookie(jar, cookie, js = false) {
    if (!cookie) return false;
    const index = jar.findIndex(item => item.name === cookie.name &&
      item.domain.replace(/^\./, '') === cookie.domain.replace(/^\./, '') && item.path === cookie.path);
    if (js && index >= 0 && jar[index].httpOnly) return false;
    if (index >= 0) jar.splice(index, 1);
    if (live(cookie)) jar.push(cookie);
    return true;
  }
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function cookieRules(jar, condition, startId = 1) {
    const hosts = new Set([...domains, 'store.steampowered.com', 'login.steampowered.com',
      'help.steampowered.com', 'checkout.steampowered.com', 'api.steampowered.com',
      ...jar.map(cookie => cookie.domain.replace(/^\./, ''))]);
    const rules = [];
    for (const host of hosts) {
      if (!domains.some(domain => domainMatches(host, domain))) continue;
      for (const subdomains of [false, true]) {
        const matching = jar.filter(cookie => live(cookie) && domainMatches(host, cookie.domain, cookie.hostOnly) &&
          (!subdomains || !cookie.hostOnly));
        const paths = new Set(['/', ...matching.map(cookie => cookie.path || '/')]);
        for (const path of paths) {
          const value = matching.filter(cookie => pathMatches(path, cookie.path || '/'))
            .sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
          const boundary = path.endsWith('/') ? '' : '(?:/|\\?|$)';
          rules.push({id: startId + rules.length,
            priority: host.split('.').length * 10000 + Math.min(path.length, 4000) * 2 + (subdomains ? 0 : 1),
            action: {type: 'modifyHeaders',
              requestHeaders: [value ? {header: 'cookie', operation: 'set', value} : {header: 'cookie', operation: 'remove'}],
              responseHeaders: [{header: 'set-cookie', operation: 'remove'}]},
            condition: {resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
              'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'other'],
              ...condition, regexFilter: `^https://${subdomains ? '(?:[^./]+\\.)+' : ''}${escapeRegex(host)}${escapeRegex(path)}${boundary}`}});
        }
      }
    }
    return rules;
  }
  function secretBytes(secret) {
    if (/^[\da-f]{40}$/i.test(secret)) return Uint8Array.from(secret.match(/../g), byte => parseInt(byte, 16));
    const bytes = Uint8Array.from(atob(secret), char => char.charCodeAt(0));
    if (bytes.length !== 20) throw new Error('Invalid Steam authenticator secret.');
    return bytes;
  }
  function timeBytes(time) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(Math.floor(time)));
    return bytes;
  }
  async function hmac(secret, data) {
    const key = await crypto.subtle.importKey('raw', secretBytes(secret), {name: 'HMAC', hash: 'SHA-1'}, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
  }
  async function authCode(secret, time = Date.now() / 1000) {
    const digest = await hmac(secret, timeBytes(Math.floor(time / 30)));
    let value = new DataView(digest.buffer).getUint32(digest[19] & 15) & 0x7fffffff, result = '';
    const alphabet = '23456789BCDFGHJKMNPQRTVWXY';
    for (let i = 0; i < 5; i++, value = Math.floor(value / alphabet.length)) result += alphabet[value % alphabet.length];
    return result;
  }
  async function confirmationKey(secret, time, tag) {
    const digest = await hmac(secret, new Uint8Array([...timeBytes(time), ...new TextEncoder().encode(tag.slice(0, 32))]));
    return btoa(String.fromCharCode(...digest));
  }
  async function sha1(value) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value))),
      byte => byte.toString(16).padStart(2, '0')).join('');
  }
  globalThis.SUMCore = {domains, domainMatches, pathMatches, isSteamURL, live, cookiesFor, parseCookie,
    putCookie, cookieRules, secretBytes, authCode, confirmationKey, sha1};
})();
