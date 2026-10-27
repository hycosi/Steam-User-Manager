'use strict';
const id = new URLSearchParams(location.search).get('id');
const list = document.querySelector('#mobileconf_list');
const status = document.querySelector('#status');
const selectAll = document.querySelector('#select-all');
const buttons = ['allow', 'cancel'].map(name => document.getElementById(name));
let confirmations = [], busy = false;
const selected = () => [...list.querySelectorAll('input:checked')].map(input => confirmations[Number(input.dataset.index)]);
function controls() {
  const count = selected().length;
  buttons.forEach(button => button.disabled = busy || !count);
  document.querySelector('#refresh').disabled = busy;
  selectAll.disabled = busy || !confirmations.length;
  selectAll.checked = count > 0 && count === confirmations.length;
  selectAll.indeterminate = count > 0 && count < confirmations.length;
  list.querySelectorAll('input').forEach(input => input.disabled = busy);
}
async function request(message) {
  const result = await chrome.runtime.sendMessage({...message, id});
  if (result?.error) throw new Error(result.error);
  return result;
}
async function refresh() {
  busy = true; controls(); status.textContent = 'Загрузка…';
  try {
    const result = await request({type: 'confirm:list'});
    document.querySelector('#account').textContent = result.login;
    document.title = `${result.login} :: Подтверждения`;
    confirmations = result.conf || [];
    list.replaceChildren();
    for (const [index, item] of confirmations.entries()) {
      const row = document.createElement('label');
      row.className = 'mobileconf_list_entry';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.dataset.index = index;
      checkbox.addEventListener('change', controls);
      row.append(checkbox);
      if (item.icon) {
        const url = new URL(item.icon);
        if (url.protocol === 'https:') {
          const image = document.createElement('img'); image.src = url.href; image.alt = ''; row.append(image);
        }
      }
      const description = document.createElement('div'); description.className = 'mobileconf_list_entry_description';
      const heading = document.createElement('strong'); heading.textContent = item.headline || item.type_name || 'Подтверждение';
      description.append(heading);
      for (const line of [item.type_name, ...(item.summary || []), item.creation_time ? new Date(item.creation_time * 1000).toLocaleString() : ''].filter(Boolean)) {
        const text = document.createElement('p'); text.textContent = line; description.append(text);
      }
      if (item.warn) { const warning = document.createElement('p'); warning.className = 'warning'; warning.textContent = item.warn; description.append(warning); }
      row.append(description); list.append(row);
    }
    status.textContent = confirmations.length ? 'Проверьте записи перед подтверждением или отклонением.' : 'Нет ожидающих подтверждений.';
  } catch (error) { status.textContent = error.message; }
  finally { busy = false; controls(); }
}
selectAll.addEventListener('change', () => {
  list.querySelectorAll('input').forEach(input => input.checked = selectAll.checked); controls();
});
for (const button of buttons) button.addEventListener('click', async () => {
  const items = selected(), operation = button.id;
  if (!items.length || !window.confirm(`${operation === 'allow' ? 'Подтвердить' : 'Отклонить'} ${items.length} выбранных записей?`)) return;
  busy = true; controls();
  let completed = 0;
  try {
    for (const item of items) {
      status.textContent = `Обработка ${completed + 1} из ${items.length}…`;
      await request({type: 'confirm:act', operation, item: {id: item.id, nonce: item.nonce}});
      completed++;
    }
    await refresh();
  } catch (error) {
    await refresh();
    status.textContent = `Обработано: ${completed} из ${items.length}. ${error.message}`;
  } finally { busy = false; controls(); }
});
document.querySelector('#refresh').addEventListener('click', refresh);
refresh();
