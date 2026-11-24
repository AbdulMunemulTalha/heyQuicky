// Connect the extension with the code from HeyQuicky → Settings → Integrations → Chrome extension.
const T = {
  en: { howTo: 'In HeyQuicky open Settings → Integrations → Chrome extension and click "Get a connect code".', server: 'HeyQuicky address', code: 'Connect code', connect: 'Connect',
    ready: 'Open the Business Suite inbox — the HeyQuicky panel shows on the right of every chat.', openInbox: 'Open Business Suite inbox', signout: 'Disconnect', who: (n, s) => `Connected as ${n} · ${s}`,
    needServer: 'Enter your HeyQuicky address', needCode: 'Enter the 8-letter code', denied: 'Allow access to your HeyQuicky address to connect' },
  bn: { howTo: 'HeyQuicky-তে Settings → Integrations → Chrome extension খুলে "কানেক্ট কোড নিন" চাপুন।', server: 'HeyQuicky ঠিকানা', code: 'কানেক্ট কোড', connect: 'কানেক্ট করুন',
    ready: 'বিজনেস স্যুটের ইনবক্স খুলুন — প্রতিটি চ্যাটের ডানে HeyQuicky প্যানেল দেখাবে।', openInbox: 'বিজনেস স্যুট ইনবক্স খুলুন', signout: 'ডিসকানেক্ট', who: (n, s) => `${n} হিসেবে কানেক্টেড · ${s}`,
    needServer: 'HeyQuicky ঠিকানা লিখুন', needCode: '৮ অক্ষরের কোড লিখুন', denied: 'কানেক্ট করতে HeyQuicky ঠিকানায় অনুমতি দিন' },
};
const $ = (id) => document.getElementById(id);
let lang = 'en';

async function render() {
  const s = await chrome.storage.local.get(['token', 'name', 'shop', 'lang']);
  lang = s.lang || (chrome.i18n.getUILanguage().startsWith('bn') ? 'bn' : 'en');
  $('lang').value = lang;
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = T[lang][el.dataset.t]; });
  const preset = await chrome.runtime.sendMessage({ type: 'server' });
  $('server').value = $('server').value || preset || '';
  $('serverRow').hidden = Boolean(self.HQ_PRESET ?? false);
  $('out').hidden = Boolean(s.token);
  $('in').hidden = !s.token;
  if (s.token) $('who').textContent = T[lang].who(s.name || '', s.shop || '');
}

$('lang').addEventListener('change', async (e) => { await chrome.storage.local.set({ lang: e.target.value }); render(); });

$('connect').addEventListener('click', async () => {
  const server = $('server').value.trim().replace(/\/+$/, '');
  const code = $('code').value.trim();
  $('err').textContent = '';
  if (!/^https?:\/\//.test(server)) { $('err').textContent = T[lang].needServer; return; }
  if (code.replace(/[^a-z0-9]/gi, '').length !== 8) { $('err').textContent = T[lang].needCode; return; }
  // The extension may only talk to the shop's own HeyQuicky address — ask for it now (needs this click).
  const granted = await chrome.permissions.request({ origins: [`${new URL(server).origin}/*`] }).catch(() => false);
  if (!granted) { $('err').textContent = T[lang].denied; return; }
  $('connect').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'connect', server, code });
  $('connect').disabled = false;
  if (!r?.ok) { $('err').textContent = r?.error || 'Could not connect'; return; }
  render();
});

$('open').addEventListener('click', () => chrome.tabs.create({ url: 'https://business.facebook.com/latest/inbox/all' }));
$('signout').addEventListener('click', async () => { await chrome.runtime.sendMessage({ type: 'signout' }); render(); });
render();
