/* Isolated-world bridge. Only account-local cookies/storage and Steam navigation are accepted. */
(() => {
  'use strict';
  const publish = (snapshot, ack = false) => window.postMessage({channel: 'SUM:extension', snapshot, ack}, location.origin);
  let initialized = false, snapshot = null, queue = Promise.resolve();
  async function refresh() {
    snapshot = await chrome.runtime.sendMessage({type: 'sum:init'});
    initialized = true;
    if (!snapshot?.error) publish(snapshot);
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'SUM:page') return;
    const data = event.data.payload;
    if (data?.type === 'sum:ready') {
      if (initialized) publish(snapshot);
      return;
    }
    if (!snapshot || !['sum:cookie', 'sum:storage', 'sum:open'].includes(data?.type)) return;
    // Serialize writes with snapshots, preserving JS mutation order.
    queue = queue.then(async () => {
      const response = await chrome.runtime.sendMessage(data);
      if (data.type === 'sum:cookie' || data.type === 'sum:storage') {
        snapshot = await chrome.runtime.sendMessage({type: 'sum:init'});
        if (snapshot && !snapshot.error) publish(snapshot, data.type === 'sum:storage');
      }
      if (response?.error) console.warn('SUM:', response.error);
    }).catch(error => console.warn('SUM:', error.message));
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'sum:refresh') queue = queue.then(refresh).catch(() => {});
  });
  refresh().catch(() => {});
})();
