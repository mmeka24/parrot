/**
 * The toolbar popup: is Parrot reachable, which server, and - stated plainly -
 * what is running in test mode right now.
 */

import { copy } from '@parrot/shared/copy';
import { ask } from './messages';

const t = copy.extension;

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`popup.html is missing #${id}`);
  return node as T;
}

async function render(): Promise<void> {
  byId('name').textContent = t.name;
  byId('tagline').textContent = t.tagline;
  byId('server-label').textContent = t.popupServer;
  byId('save').textContent = t.popupSave;
  byId('active-on').textContent = `${t.popupActiveOn}: localhost`;

  const server = await ask({ type: 'getServer' });
  if (server.ok) byId<HTMLInputElement>('server').value = server.data;

  const state = byId('state');
  const config = await ask({ type: 'config' });

  if (!config.ok) {
    state.dataset.state = 'off';
    byId('state-text').textContent = `${t.popupDisconnected}. ${t.offline}`;
    byId('test-section').hidden = true;
    byId('links').hidden = true;
    return;
  }

  state.dataset.state = 'on';
  byId('state-text').textContent = t.popupConnected;

  const test = byId('test');
  test.replaceChildren();
  if (config.data.simulated.length > 0) {
    const heading = document.createElement('p');
    heading.textContent = t.popupTestMode;
    const list = document.createElement('ul');
    for (const item of config.data.simulated) {
      const li = document.createElement('li');
      li.textContent = item;
      list.append(li);
    }
    test.append(heading, list);
  } else {
    const line = document.createElement('p');
    line.textContent = t.popupAllReal;
    test.append(line);
  }
  byId('test-section').hidden = false;

  const dashboard = byId<HTMLAnchorElement>('dashboard');
  dashboard.href = `${config.data.webUrl}/agents`;
  dashboard.textContent = t.popupDashboard;
  byId('links').hidden = false;
}

byId<HTMLFormElement>('server-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const note = byId('server-note');
  const value = byId<HTMLInputElement>('server').value;
  void ask({ type: 'setServer', server: value }).then((result) => {
    note.textContent = result.ok ? t.popupSaved : result.error;
    void render();
  });
});

void render();
