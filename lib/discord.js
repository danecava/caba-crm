'use strict';
/*
 * discord.js — fire-and-forget Discord notifications via webhook.
 * Set DISCORD_WEBHOOK_URL (Railway env). No URL = silently disabled.
 */
const WEBHOOK = process.env.DISCORD_WEBHOOK_URL || null;

function enabled() { return !!WEBHOOK; }

async function notify(content) {
  if (!WEBHOOK) return { ok: false, reason: 'no_webhook' };
  try {
    const r = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: String(content).slice(0, 1900), allowed_mentions: { parse: [] } }),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
}

module.exports = { enabled, notify };
