/* UNIT notification server.

   The app can't wake itself up on a locked phone, so this sends the alerts:

   · rest timer  users/{uid}/rest gets {id, end, ex, next, at, bg}. When bg turns
                 true (the phone was locked or the app was left), this sends
                 "Rest until 11:42:30 · Next: …" right away, schedules
                 "30 seconds left" and "Rest over — go" for the exact moments,
                 and checks again at each moment that the same rest is still
                 running and the app is still in the background.
   · Hub         every notif/{uid}/{id} is pushed too
   · test        users/{uid}/push/test sends a sample notification

   Phones are listed under users/{uid}/push/tok/{key} = {t: token}. Dead tokens
   are removed after a failed send. Settings under users/{uid}/push/prefs
   ({rest, hub}) switch each kind off. */

const {onValueWritten, onValueCreated} = require('firebase-functions/v2/database');
const {onTaskDispatched} = require('firebase-functions/v2/tasks');
const {setGlobalOptions} = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const {initializeApp} = require('firebase-admin/app');
const {getDatabase} = require('firebase-admin/database');
const {getMessaging} = require('firebase-admin/messaging');
const {getFunctions} = require('firebase-admin/functions');

initializeApp();
setGlobalOptions({region: 'us-central1', maxInstances: 10});
const REGION = 'us-central1';
const INSTANCE = 'unit-training-75114-default-rtdb';
const DB = {region: REGION, instance: INSTANCE};
const db = () => getDatabase();

const WARN_AT = 30;                  // seconds before the end
const DEAD = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);

async function prefsOf(uid) {
  const v = (await db().ref(`users/${uid}/push/prefs`).get()).val() || {};
  return {rest: v.rest !== false, hub: v.hub !== false};
}

/* One message to every phone this person has switched notifications on for.
   Data-only: the app's service worker (sw.js) builds the notification. */
async function sendTo(uid, data, {ttl = 60} = {}) {
  const v = (await db().ref(`users/${uid}/push/tok`).get()).val() || {};
  const toks = Object.entries(v).map(([k, x]) => ({k, t: x && x.t})).filter(x => x.t);
  if (!toks.length) return 0;
  const payload = {};
  for (const [k, val] of Object.entries(data)) if (val !== undefined && val !== null) payload[k] = String(val);
  const res = await getMessaging().sendEach(toks.map(x => ({
    token: x.t,
    data: payload,
    webpush: {headers: {Urgency: 'high', TTL: String(Math.max(5, Math.round(ttl)))}},
  })));
  const dead = {};
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      logger.warn('push failed', {uid, code});
      if (DEAD.has(code)) dead[`users/${uid}/push/tok/${toks[i].k}`] = null;
    }
  });
  if (Object.keys(dead).length) await db().ref().update(dead);
  return res.successCount;
}

function nextLine(r) {
  const n = clip(r.next, 140);
  return n ? `Next: ${n}` : (r.ex ? `After ${clip(r.ex, 60)}` : '');
}

/* ── rest timer ───────────────────────────────────────────── */

async function schedule(uid, r, kind, at) {
  const queue = getFunctions().taskQueue(`locations/${REGION}/functions/restAlarm`);
  const id = `${uid}-${r.id}-${kind}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 480);
  try {
    await queue.enqueue({uid, id: r.id, kind}, {scheduleTime: new Date(at), id});
  } catch (e) {
    // the same rest already has this alert booked (phone locked twice) — fine
    if (e && /already-exists|ALREADY_EXISTS/i.test(String(e.code || e.message))) return;
    throw e;
  }
}

exports.restPush = onValueWritten({...DB, ref: '/users/{uid}/rest'}, async (event) => {
  const uid = event.params.uid;
  const before = event.data.before.val();
  const r = event.data.after.val();
  if (!r || !r.bg || !r.id || !r.end) return;
  // only act the moment this rest goes into the background
  if (before && before.bg && before.id === r.id) return;
  if (!(await prefsOf(uid)).rest) return;

  const end = Number(r.end);
  const left = (end - Date.now()) / 1000;
  if (left <= 1.5) {                      // ran out while the phone was locking
    if (left > -10) await sendTo(uid, {kind: 'rest-done', title: 'Rest over — go', body: nextLine(r), url: './#train'}, {ttl: 120});
    return;
  }
  const at = clip(r.at, 20);
  await Promise.all([
    left >= 6 ? sendTo(uid, {
      kind: 'rest-start',
      title: at ? `Rest until ${at}` : 'Resting',
      body: nextLine(r),
      url: './#train',
    }, {ttl: left}) : null,
    left >= WARN_AT + 15 ? schedule(uid, r, 'warn', end - WARN_AT * 1000) : null,
    schedule(uid, r, 'done', end),
  ]);
});

exports.restAlarm = onTaskDispatched({
  region: REGION,
  retryConfig: {maxAttempts: 3, minBackoffSeconds: 1, maxBackoffSeconds: 5},
  rateLimits: {maxConcurrentDispatches: 100},
  memory: '256MiB',
}, async (req) => {
  const {uid, id, kind} = req.data || {};
  if (!uid || !id) return;
  const r = (await db().ref(`users/${uid}/rest`).get()).val();
  // ended early, restarted, or the app is open and ringing by itself
  if (!r || r.id !== id || !r.bg) return;
  if (!(await prefsOf(uid)).rest) return;
  const left = Math.round((Number(r.end) - Date.now()) / 1000);
  if (kind === 'warn') {
    if (left < 5) return;
    await sendTo(uid, {kind: 'rest-warn', title: `${left} seconds left`, body: nextLine(r), url: './#train'}, {ttl: left});
  } else if (kind === 'done') {
    if (left < -60) return;               // far too late to be useful
    await sendTo(uid, {kind: 'rest-done', title: 'Rest over — go', body: nextLine(r), url: './#train'}, {ttl: 120});
  }
});

/* ── Hub ──────────────────────────────────────────────────── */

function hubText(n) {
  const who = clip(n.n, 40) || 'Someone';
  const txt = clip(n.txt, 90);
  switch (n.t) {
    case 'req': return {title: who, body: 'sent you a friend request'};
    case 'acc': return {title: who, body: 'accepted your friend request'};
    case 'tag': return {title: who, body: n.k === 'comment' ? `mentioned you: ${txt}` : (txt ? `tagged you: ${txt}` : 'tagged you')};
    case 'post': return {title: who, body: txt || 'shared a post'};
    case 'like': return {title: who, body: 'liked your post'};
    case 'comment': return {title: who, body: txt ? `commented: ${txt}` : 'commented on your post'};
    default: return {title: who, body: txt || 'New activity in the Hub'};
  }
}

exports.hubPush = onValueCreated({...DB, ref: '/notif/{uid}/{nid}'}, async (event) => {
  const uid = event.params.uid;
  const n = event.data.val() || {};
  if (n.u && n.u === uid) return;
  if (!(await prefsOf(uid)).hub) return;
  // someone they've blocked doesn't get to buzz their phone
  if (n.u && (await db().ref(`users/${uid}/blocked/${n.u}`).get()).exists()) return;
  const {title, body} = hubText(n);
  await sendTo(uid, {kind: 'hub', tag: `hub-${event.params.nid}`, title, body, url: './#hub'}, {ttl: 86400});
});

/* ── test button ──────────────────────────────────────────── */

exports.testPush = onValueWritten({...DB, ref: '/users/{uid}/push/test'}, async (event) => {
  if (!event.data.after.exists()) return;
  await sendTo(event.params.uid, {
    kind: 'test',
    title: 'Notifications are working',
    body: 'This is how your rest timer will reach you on the lock screen.',
    url: './',
  }, {ttl: 300});
});
