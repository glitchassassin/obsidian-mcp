'use strict';
const $ = id => document.getElementById(id);
let state = {}, csrf = '', active = false;
function forgetKey() { $('new-key').value = ''; $('key-result').hidden = true; }
function message(text, error = false) {$('message').textContent = text; $('message').className = error ? 'error' : '';}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {cache: 'no-store'} : {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrf}, body: JSON.stringify(body), cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.authenticated) {forgetKey(); await refresh();}
    throw new Error(result.error || 'The request failed.');
  }
  if (result.csrf) csrf = result.csrf;
  return result;
}
async function refresh() {
  state = await api('status');
  csrf = state.csrf || '';
  $('access').hidden = state.authenticated;
  $('settings').hidden = !state.authenticated;
  $('logout').hidden = !state.authenticated;
  $('access-title').textContent = state.passwordSet ? 'Log in' : 'Create your admin password';
  $('access-submit').textContent = state.passwordSet ? 'Log in' : 'Create password';
  $('password-help').textContent = state.passwordSet ? 'Your admin password is required to manage this deployment.' : 'Use at least 12 characters. All remaining setup steps require this password.';
  $('access-form').elements.password.autocomplete = state.passwordSet ? 'current-password' : 'new-password';
  if (!state.authenticated) {
    forgetKey();
    for (const form of ['obsidian-form', 'vault-form', 'tunnel-form']) {
      for (const field of $(form).elements) if (field.type === 'password' || field.name === 'mfa') field.value = '';
    }
    return;
  }
  $('setup-status').textContent = state.initialized ? 'Setup complete. You can re-authenticate Obsidian, replace the MCP key, and update the tunnel token.' : 'Complete these steps to start your services.';
  $('account-status').textContent = state.account ? `Account: ${state.account.email}${state.vault ? ' (locked)' : ''}` : 'Log into the Obsidian account that owns or shares your Sync vault.';
  const email = $('obsidian-form').elements.email;
  email.value = state.account?.email || '';
  email.readOnly = Boolean(state.vault);
  $('obsidian-submit').textContent = state.vault ? 'Re-authenticate Obsidian' : 'Log into Obsidian';
  $('vault-status').textContent = state.vault ? `Vault: ${state.vault.name} (locked)` : 'Select your existing remote vault. You cannot change it afterward.';
  $('vault-setup').hidden = Boolean(state.vault);
  $('load-vaults').disabled = !state.account;
  $('key-status').textContent = state.mcpConfigured ? `Key configured${state.keyCreatedAt ? ` · ${new Date(state.keyCreatedAt).toLocaleString()}` : ''}. Existing keys cannot be displayed.` : 'Generate a bearer key for your MCP gateway.';
  $('generate-key').textContent = state.mcpConfigured ? 'Regenerate key' : 'Generate key';
  $('generate-key').disabled = !state.vault;
  $('tunnel').hidden = !state.tunnelRequired;
  $('tunnel-status').textContent = state.tunnelConfigured ? 'Connector token configured. Saving a replacement restarts the connector.' : 'Paste the connector token from Cloudflare.';
  $('tunnel-form').elements.token.disabled = !state.vault;
  $('tunnel-form').querySelector('button').disabled = !state.vault;
  $('finish').hidden = Boolean(state.initialized);
  $('initialize').disabled = !(state.vault && state.mcpConfigured && (!state.tunnelRequired || state.tunnelConfigured));
}
function action(fn) {
  return async event => {
    event?.preventDefault();
    if (active) return;
    active = true;
    const button = event?.submitter || event?.currentTarget;
    const previous = button?.disabled;
    if (button && 'disabled' in button) button.disabled = true;
    message('Working…');
    try {await fn(event);}
    catch (error) {message(error.message, true);}
    finally {active = false; if (button && 'disabled' in button) button.disabled = previous; await refresh().catch(() => {});}
  };
}
$('access-form').addEventListener('submit', action(async () => {
  const field = $('access-form').elements.password, password = field.value; field.value = '';
  await api(state.passwordSet ? 'login' : 'password', {password}); message('Admin access ready.');
}));
$('logout').addEventListener('click', action(async () => {forgetKey(); await api('logout', {}); message('Logged out.');}));
$('obsidian-form').addEventListener('submit', action(async () => {
  const form = $('obsidian-form');
  const data = Object.fromEntries(new FormData(form));
  form.elements.password.value = ''; form.elements.mfa.value = '';
  await api('obsidian', data); message('Obsidian authentication saved.');
}));
$('load-vaults').addEventListener('click', action(async () => {
  const {vaults} = await api('vaults');
  const select = $('vault-form').elements.id; select.replaceChildren();
  for (const vault of vaults) {const option = document.createElement('option'); option.value = vault.id; option.textContent = vault.name; select.append(option);}
  $('vault-form').hidden = !vaults.length;
  message(vaults.length ? 'Choose your vault below.' : 'No Sync vaults were found for this account.');
}));
$('vault-form').addEventListener('submit', action(async () => {
  const data = Object.fromEntries(new FormData($('vault-form'))); $('vault-form').elements.password.value = '';
  await api('vault', data); message('Vault selected. The account and vault are now locked.');
}));
$('generate-key').addEventListener('click', action(async () => {
  if (state.mcpConfigured && !confirm('Replace the MCP key? Existing sessions will disconnect. Update MCP Portal or your client with the new key.')) {message('Key unchanged.'); return;}
  forgetKey(); const {key} = await api('key', {regenerate: Boolean(state.mcpConfigured)});
  $('new-key').value = key; $('key-result').hidden = false;
  message('New key created. Save it before leaving this page.');
}));
$('dismiss-key').addEventListener('click', () => {forgetKey(); message('Key hidden. It cannot be displayed again.');});
$('tunnel-form').addEventListener('submit', action(async () => {
  const field = $('tunnel-form').elements.token, token = field.value; field.value = '';
  await api('tunnel', {token}); message('Tunnel token saved.');
}));
$('initialize').addEventListener('click', action(async () => {await api('initialize', {}); message('Setup complete. Your services are starting.');}));
window.addEventListener('pagehide', forgetKey);
window.addEventListener('pageshow', event => {if (event.persisted) {forgetKey(); refresh().catch(() => {});}});
setInterval(() => {if (!active) refresh().catch(() => {});}, 60000);
refresh().catch(error => message(error.message, true));
