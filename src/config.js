import { parseKey } from './secrets.js';

// Values pasted into hosting dashboards often pick up spaces or quotes.
function cleanSecret(value) {
  return String(value ?? '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    mongoUrl: env.MONGODB_URI || 'mongodb://127.0.0.1:27017/quicky',
    // A SQLite database from before the move to MongoDB. Copied in once, on the
    // first start with an empty MongoDB; the file itself is never changed.
    sqliteImportPath: env.SQLITE_IMPORT_PATH || '',
    isProduction: env.NODE_ENV === 'production',
    // When true, replies are stored but never sent to Meta. Useful for local demos.
    dryRun: env.DRY_RUN === '1' || env.DRY_RUN === 'true',
    // Public https address of this server, used for the Facebook login redirect.
    // Falls back to the address the request came in on.
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    tokenKey: parseKey(env.TOKEN_ENCRYPTION_KEY),
    // Password for /admin/leads.csv (sign-up leads for follow-up). Empty turns the page off.
    adminToken: cleanSecret(env.ADMIN_TOKEN),
    // Manual AI-credit top-ups: HeyQuicky's own bKash / Nagad numbers shops send money to.
    // Empty hides that method; top-ups are credited only after an admin approves the TrxID.
    topup: {
      bkash: (env.TOPUP_BKASH_NUMBER || '').trim(),
      nagad: (env.TOPUP_NAGAD_NUMBER || '').trim(),
      supportWhatsapp: (env.SUPPORT_WHATSAPP || '').trim(),
    },
    // Shown on the privacy policy, terms and data deletion pages.
    legal: {
      operator: env.OPERATOR_NAME || 'Quicky',
      supportEmail: env.SUPPORT_EMAIL || 'info@heyquicky.com',
      updated: env.LEGAL_UPDATED || '2 October 2026',
    },
    // AI chat agent. Off unless an API key is set for the chosen provider.
    ai: {
      provider: env.AI_PROVIDER || 'claude',
      apiKey: cleanSecret(env.ANTHROPIC_API_KEY),
      model: env.AI_MODEL || 'claude-haiku-5-5',
      // Credit charged per call = real token cost (USD) × USD_TO_BDT × (1 + AI_MARKUP_PCT / 100).
      usdToBdt: Number(env.USD_TO_BDT || 122),
      markupPct: Number(env.AI_MARKUP_PCT || 0),
      // Off: every AI call is priced and recorded, nothing is deducted and the AI never pauses.
      // On (AI_CREDIT_ENFORCED=1): credit is charged and the AI pauses at zero credit or the monthly cap.
      creditEnforced: env.AI_CREDIT_ENFORCED === '1' || env.AI_CREDIT_ENFORCED === 'true',
      // Reasoning effort for chat replies: low keeps them quick and inexpensive.
      effort: env.AI_EFFORT || 'low',
      // How long to wait for a customer to finish typing before answering.
      // Unset: each shop's own "Reply delay" (AI agent → persona) decides. Set to force one delay for every shop.
      replyDelayMs: env.AI_REPLY_DELAY_MS == null || env.AI_REPLY_DELAY_MS === '' ? null : Number(env.AI_REPLY_DELAY_MS),
      // Voice notes to text (AI-04). Without OPENAI_API_KEY, voice notes go to the team.
      openaiKey: cleanSecret(env.OPENAI_API_KEY),
      transcribeModel: env.TRANSCRIBE_MODEL || 'gpt-transcribe',
    },
    meta: {
      appId: env.META_APP_ID || '',
      appSecret: cleanSecret(env.META_APP_SECRET),
      verifyToken: env.META_VERIFY_TOKEN || '',
      graphVersion: env.META_GRAPH_VERSION || 'v23.0',
      // Facebook Login for Business configuration (Messenger + Instagram permissions).
      loginConfigId: env.META_LOGIN_CONFIG_ID || '',
      // CMT-06: also ask for posting permissions when connecting (turn on once Meta approves them).
      publishScopes: env.META_PUBLISH_SCOPES === '1',
      // WhatsApp Embedded Signup configuration.
      whatsappConfigId: env.META_WHATSAPP_CONFIG_ID || '',
    },
  };
}
