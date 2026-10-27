/* Versioned, validated account backups. No browser APIs and no network access. */
(() => {
  'use strict';
  const C = globalThis.SUMCore;
  const FORMAT = 'steam-user-manager';
  const MAX_BYTES = 20 * 1024 * 1024;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const fail = message => { throw new Error(message); };
  function text(value, label, max, optional = false) {
    if (optional && (value === undefined || value === null || value === '')) return null;
    if (typeof value !== 'string' || value.length > max) fail(`Некорректное поле «${label}» в резервной копии.`);
    return value;
  }
  function media(value) {
    if (!value) return undefined;
    const parsed = new URL(text(value, 'Изображение профиля', 4096));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail('Некорректная ссылка профиля в резервной копии.');
    return parsed.href;
  }
  function cookie(value) {
    if (!object(value)) fail('Некорректные cookies в резервной копии.');
    const domain = text(value.domain, 'Домен cookie', 255).toLowerCase();
    const host = domain.replace(/^\./, '');
    if (!C.domains.some(base => C.domainMatches(host, base)) || !/^[a-z0-9.-]+$/.test(host)) fail('В резервной копии найден cookie за пределами Steam.');
    const name = text(value.name, 'Имя cookie', 1024), content = text(value.value, 'Значение cookie', 16384);
    const path = text(value.path || '/', 'Путь cookie', 2048);
    if (!name || /[\s\x00-\x1f\x7f()<>@,;:\\"/\[\]?={}]/.test(name) || /[\x00-\x1f\x7f;]/.test(content) || !path.startsWith('/')) fail('Некорректные cookies в резервной копии.');
    const sameSite = value.sameSite || 'unspecified';
    if (!['unspecified', 'no_restriction', 'lax', 'strict'].includes(sameSite)) fail('Некорректный SameSite cookie.');
    const result = {domain, name, value: content, path, hostOnly: value.hostOnly ?? !domain.startsWith('.'),
      secure: !!value.secure, httpOnly: !!value.httpOnly, sameSite, session: value.session ?? value.expirationDate === undefined};
    if (typeof result.hostOnly !== 'boolean' || typeof result.session !== 'boolean') fail('Некорректные флаги cookie.');
    if (!result.session) {
      if (typeof value.expirationDate !== 'number' || !Number.isFinite(value.expirationDate)) fail('Некорректный срок cookie.');
      result.expirationDate = value.expirationDate;
    }
    return result;
  }
  function localStorage(value) {
    if (value === undefined) return {};
    if (!object(value)) fail('Некорректное хранилище аккаунта.');
    const result = Object.create(null);
    for (const [origin, values] of Object.entries(value)) {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || !object(values)) fail('Некорректное хранилище аккаунта.');
      result[origin] = Object.create(null);
      for (const [key, value] of Object.entries(values)) result[origin][key] = text(value, 'Значение хранилища', 5 * 1024 * 1024);
    }
    return result;
  }
  async function account(value) {
    if (!object(value)) fail('Некорректная запись аккаунта.');
    const login = text(value.login, 'Логин', 64).toLowerCase().trim();
    if (!/^[a-z0-9_]{1,64}$/.test(login)) fail('В резервной копии найден некорректный логин.');
    const steamid = text(value.steamid, 'SteamID', 17);
    if (!/^\d{17}$/.test(steamid)) fail(`Не указан SteamID для ${login}.`);
    const number = BigInt(steamid) - 76561197960265728n;
    if (number < 0n || number > 4294967295n) fail(`Некорректный SteamID для ${login}.`);
    const accountid = String(number);
    if (value.accountid !== undefined && String(value.accountid) !== accountid) fail(`SteamID и ID аккаунта не совпадают: ${login}.`);
    const result = {login, steamid, accountid, password: text(value.password, 'Пароль', 4096, true),
      shared_secret: text(value.shared_secret, 'Shared secret', 128, true), identity_secret: text(value.identity_secret, 'Identity secret', 128, true),
      device_id: text(value.device_id, 'Device ID', 64, true), urls: [], cookies: [],
      storage: {local: localStorage(value.storage?.local), session: {}}};
    for (const secret of [result.shared_secret, result.identity_secret]) if (secret) {
      try { C.secretBytes(secret); } catch { fail(`Некорректный секрет Steam Guard для ${login}.`); }
    }
    if (result.device_id && !/^android:[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(result.device_id)) fail(`Некорректный Device ID для ${login}.`);
    if (result.identity_secret && !result.device_id) {
      result.device_id = `android:${(await C.sha1(steamid)).slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5')}`;
    }
    if (value.cookies !== undefined && !Array.isArray(value.cookies)) fail(`Некорректные cookies для ${login}.`);
    if ((value.cookies || []).length > 2000) fail(`Слишком много cookies для ${login}.`);
    for (const item of (value.cookies || [])) C.putCookie(result.cookies, cookie(item));
    if (value.urls !== undefined && (!Array.isArray(value.urls) || value.urls.length > 18)) fail(`Некорректные ссылки для ${login}.`);
    const slots = new Set();
    for (const item of value.urls || []) {
      if (!object(item)) fail(`Некорректная ссылка для ${login}.`);
      const url = new URL(text(item.href, 'Ссылка', 4096));
      const slot = typeof item.n === 'string' && /^\d+$/.test(item.n) ? Number(item.n) : item.n;
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !Number.isInteger(slot) || slot < 0 || slot > 17 || slots.has(slot)) fail(`Некорректная ссылка для ${login}.`);
      slots.add(slot); result.urls.push({href: url.href, hostname: url.hostname, n: slot});
    }
    if (value.name !== undefined) result.name = text(value.name, 'Имя профиля', 512);
    for (const key of ['avatar', 'frame', 'video']) { const url = media(value[key]); if (url) result[key] = url; }
    if (value.level !== undefined) {
      if (!Number.isInteger(value.level) || value.level < 0 || value.level > 1000000) fail(`Некорректный уровень Steam для ${login}.`);
      result.level = value.level;
    }
    return result;
  }
  async function read(document) {
    if (!object(document) || document.format !== FORMAT || document.version !== 1 || !Array.isArray(document.accounts)) fail('Выберите JSON-резервную копию Steam User Manager версии 1.');
    if (JSON.stringify(document).length > MAX_BYTES || document.accounts.length > 1000) fail('Резервная копия слишком большая (максимум 20 МБ и 1 000 аккаунтов).');
    const results = [], logins = new Set(), steamids = new Set();
    for (const item of document.accounts) {
      const parsed = await account(item);
      if (logins.has(parsed.login) || steamids.has(parsed.steamid)) fail(`В файле повторяется аккаунт ${parsed.login}.`);
      logins.add(parsed.login); steamids.add(parsed.steamid); results.push(parsed);
    }
    return results;
  }
  function create(accounts, version) {
    return {format: FORMAT, version: 1, appVersion: version, exportedAt: new Date().toISOString(), accounts:
      Object.values(accounts).filter(value => value.accountid).map(value => {
        const result = structuredClone(value);
        result.storage = {local: result.storage?.local || {}, session: {}};
        delete result.ConfLink;
        return result;
      })};
  }
  function plan(incoming, existing, overwrite = false) {
    const entries = incoming.map(account => {
      const matches = Object.entries(existing).filter(([, saved]) => saved.login === account.login || saved.steamid === account.steamid);
      if (matches.length > 1 || matches.some(([, saved]) => saved.steamid !== account.steamid || saved.login !== account.login)) fail(`Конфликт SteamID и логина для ${account.login}. Импорт отменён.`);
      const existingId = matches[0]?.[0];
      return {account, existingId, action: existingId ? overwrite ? 'update' : 'skip' : 'add'};
    });
    return {entries, summary: {total: entries.length, added: entries.filter(item => item.action === 'add').length,
      updated: entries.filter(item => item.action === 'update').length, skipped: entries.filter(item => item.action === 'skip').length,
      accounts: entries.map(item => ({login: item.account.login, action: item.action}))}};
  }
  globalThis.SUMBackup = {read, create, plan, MAX_BYTES};
})();
