import { graphRequest, MetaApiError } from './meta.js';

// Asked for when no Facebook Login for Business configuration is set.
// pages_messaging / instagram_manage_messages send and receive messages;
// pages_manage_metadata subscribes the Page to this app's webhooks.
// pages_read_user_content / pages_manage_engagement read, answer and hide Page comments (CMT-01); the private
// reply to a comment goes out with pages_messaging. instagram_manage_comments does the same on Instagram.
export const LOGIN_SCOPES = [
  'pages_show_list',
  'pages_messaging',
  'pages_manage_metadata',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_engagement',
  'instagram_basic',
  'instagram_manage_messages',
  'instagram_manage_comments',
  'business_management',
];

// CMT-06: posting to the Page and Instagram. Asked only when META_PUBLISH_SCOPES=1 — Meta must approve them first.
export const PUBLISH_SCOPES = ['pages_manage_posts', 'instagram_content_publish'];

const MAX_PAGE_REQUESTS = 10;

export function createMetaClient({ appId, appSecret, graphVersion, publishScopes = false, fetchImpl = globalThis.fetch }) {
  const base = `https://graph.facebook.com/${graphVersion}`;
  const url = (path, params = {}) => {
    const u = new URL(`${base}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };
  const get = (path, params, accessToken) => graphRequest(url(path, params), { accessToken, fetchImpl });
  const post = (path, body, accessToken) => graphRequest(url(path), { method: 'POST', body, accessToken, fetchImpl });

  return {
    loginUrl({ redirectUri, state, configId, rerequest = false }) {
      const u = new URL(`https://www.facebook.com/${graphVersion}/dialog/oauth`);
      u.searchParams.set('client_id', appId);
      u.searchParams.set('redirect_uri', redirectUri);
      u.searchParams.set('state', state);
      u.searchParams.set('response_type', 'code');
      if (configId) u.searchParams.set('config_id', configId);
      else u.searchParams.set('scope', [...LOGIN_SCOPES, ...(publishScopes ? PUBLISH_SCOPES : [])].join(','));
      // Asks again for permissions the person switched off last time.
      if (rerequest) u.searchParams.set('auth_type', 'rerequest');
      return u.toString();
    },

    // Code from the login redirect -> long-lived user token. Page tokens read
    // with a long-lived user token do not expire.
    async userTokenFromCode({ code, redirectUri }) {
      const short = await get('oauth/access_token', { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code });
      const long = await get('oauth/access_token', {
        grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token,
      });
      return long.access_token;
    },

    async listPages(userToken) {
      const pages = [];
      let next = url('me/accounts', { fields: 'id,name,category,fan_count,access_token,instagram_business_account{id,username}', limit: '100' });
      for (let i = 0; next && i < MAX_PAGE_REQUESTS; i += 1) {
        const data = await graphRequest(next, { accessToken: userToken, fetchImpl });
        for (const p of data.data ?? []) {
          const ig = p.instagram_business_account;
          pages.push({
            id: String(p.id),
            name: p.name,
            category: p.category ?? null,
            followers: Number.isFinite(p.fan_count) ? p.fan_count : null,
            accessToken: p.access_token,
            instagram: ig ? { id: String(ig.id), username: ig.username ?? null } : null,
          });
        }
        next = data.paging?.next ?? null;
      }
      return pages;
    },

    // What the person allowed in the Facebook window: { permission: 'granted' | 'declined' }.
    async grantedPermissions(userToken) {
      const data = await get('me/permissions', {}, userToken);
      return Object.fromEntries((data.data ?? []).map((p) => [p.permission, p.status]));
    },

    async userName(userToken) {
      return (await get('me', { fields: 'name' }, userToken)).name ?? null;
    },

    // Without this the Page's (and its Instagram account's) messages never reach our webhook.
    async subscribePage(pageId, pageToken) {
      const data = await post(`${pageId}/subscribed_apps`, { subscribed_fields: 'messages,message_echoes' }, pageToken);
      if (data.success === false) throw new MetaApiError('Facebook refused to subscribe the Page to messages');
    },

    // Embedded Signup returns a code that is exchanged without a redirect URI.
    async businessTokenFromCode(code) {
      const data = await get('oauth/access_token', { client_id: appId, client_secret: appSecret, code });
      return data.access_token;
    },

    async subscribeWaba(wabaId, token) {
      await post(`${wabaId}/subscribed_apps`, {}, token);
    },

    // Puts the number on the Cloud API. The PIN becomes its two-step verification PIN.
    async registerPhone(phoneNumberId, token, pin) {
      await post(`${phoneNumberId}/register`, { messaging_product: 'whatsapp', pin }, token);
    },

    // The WhatsApp accounts this token may manage, from Meta's token check (granular scopes).
    async wabaIdsFromToken(token) {
      const data = await get('debug_token', { input_token: token }, `${appId}|${appSecret}`);
      const scope = (data.data?.granular_scopes ?? []).find((s) => s.scope === 'whatsapp_business_management')
        ?? (data.data?.granular_scopes ?? []).find((s) => s.scope === 'whatsapp_business_messaging');
      return (scope?.target_ids ?? []).map(String);
    },

    async wabaPhoneNumbers(wabaId, token) {
      const data = await get(`${wabaId}/phone_numbers`, { fields: 'id,display_phone_number,verified_name' }, token);
      return data.data ?? [];
    },

    // Coexistence: asks Meta to send the Business app's contacts or chat history as webhooks.
    async requestAppDataSync(phoneNumberId, token, syncType) {
      await post(`${phoneNumberId}/smb_app_data`, { messaging_product: 'whatsapp', sync_type: syncType }, token);
    },

    async phoneNumber(phoneNumberId, token) {
      return get(phoneNumberId, { fields: 'display_phone_number,verified_name' }, token);
    },
  };
}
