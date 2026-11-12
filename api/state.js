'use strict';
// Kovai Weekends: one shared copy of the couple's list, so two phones stay in step.
// The page seals the list with the page password before sending it, so this stores text it cannot read.
//
//   GET  /api/state?room=<id>           -> { v, d }        v is 0 and d is null when nothing is stored yet
//   POST /api/state  { room, base, d }  -> { v }           saved; base was the version the phone last saw
//                                       -> 409 { v, d }    the other phone saved first; merge and send again
//
// Needs two things on the Vercel project:
//   1. an Upstash Redis store connected to it (gives KV_REST_API_URL and KV_REST_API_TOKEN)
//   2. KW_ROOM set to the one room id this deployment serves (node build.js --room prints it)
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const ROOM = (process.env.KW_ROOM || '').trim();
const MAX = 400000; // characters of sealed text; a full list is a few thousand

async function kv(command) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || 'storage error ' + r.status);
  return j.result;
}
async function read(key) {
  const raw = await kv(['GET', key]);
  if (!raw) return { v: 0, d: null };
  try {
    const j = JSON.parse(raw);
    return { v: Number(j.v) || 0, d: typeof j.d === 'string' ? j.d : null };
  } catch (e) { return { v: 0, d: null }; }
}

module.exports = async (req, res) => {
  const send = (code, body) => {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  };
  try {
    if (!KV_URL || !KV_TOKEN || !ROOM) return send(501, { error: 'syncing is not set up on this deployment' });
    if (req.method === 'GET') {
      const room = String((req.query && req.query.room) || '');
      if (room !== ROOM) return send(403, { error: 'wrong room' });
      return send(200, await read('kw:' + room));
    }
    if (req.method === 'POST') {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
      if (!b || typeof b.room !== 'string' || typeof b.d !== 'string' || typeof b.base !== 'number') return send(400, { error: 'bad request' });
      if (b.room !== ROOM) return send(403, { error: 'wrong room' });
      if (b.d.length > MAX || !/^[A-Za-z0-9_-]+$/.test(b.d)) return send(413, { error: 'too large, or not sealed text' });
      const key = 'kw:' + b.room, cur = await read(key);
      if (cur.v !== b.base) return send(409, cur);
      await kv(['SET', key, JSON.stringify({ v: cur.v + 1, d: b.d })]);
      return send(200, { v: cur.v + 1 });
    }
    res.setHeader('Allow', 'GET, POST');
    return send(405, { error: 'method not allowed' });
  } catch (e) {
    return send(500, { error: 'storage is not answering' });
  }
};
