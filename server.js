'use strict';

// realms.chat — guest-first, no-account beta.
// Chat state is intentionally in memory so the first hosted version needs no database or paid datastore.
// Browser-local caches help each visitor keep what they have already seen; they are not a shared durable archive.

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 10000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const GUEST_SECRET = process.env.ORPHIC_GUEST_SECRET || (NODE_ENV === 'production' ? crypto.randomBytes(32).toString('hex') : 'orphic-local-dev-secret-change-before-production');
const COOKIE_NAME = 'orphic.guest';
const MAX_MESSAGES_PER_CONVERSATION = 160;

const GAME_LIST = [
  { slug: 'island-of-nurn', name: 'Island of Nurn' },
  { slug: 'dragon-kingdom-raiders', name: 'Dragon Kingdom Raiders' },
  { slug: 'the-lounge', name: 'The Lounge' },
  { slug: 'etherwords', name: 'Etherwords' },
  { slug: 'audioscape', name: 'Audioscape' }
];
const GAME_SLUGS = new Set(GAME_LIST.map(g => g.slug));

// Volatile, free-tier-friendly state. It resets when this process restarts or spins down.
const guests = new Map();                    // guestId -> { id, username, socketIds:Set, lastSeen }
const conversations = new Map();             // conversationId -> conversation
const messageHistory = new Map();             // conversationId -> message[]
const activeCalls = new Map();                 // callId -> call

function jsonError(res, status, message) { return res.status(status).json({ error: message }); }
function cleanText(value, max = 2000) { return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max); }
function makeId() { return crypto.randomUUID(); }
function isId(value) { return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value); }
function guestSignature(id) { return crypto.createHmac('sha256', GUEST_SECRET).update(id).digest('base64url'); }
function cookieGuestId(cookieHeader = '') {
  const entry = String(cookieHeader).split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + '='));
  if (!entry) return null;
  let value;
  try { value = decodeURIComponent(entry.slice(COOKIE_NAME.length + 1)); } catch (_) { return null; }
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const id = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!isId(id) || !signature) return null;
  const expected = Buffer.from(guestSignature(id));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return id;
}
function guestToken(id) { return id + '.' + guestSignature(id); }
function tokenGuestId(token) {
  const value = String(token || '');
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const id = value.slice(0, dot), sig = value.slice(dot + 1);
  if (!isId(id) || !sig) return null;
  const expected = Buffer.from(guestSignature(id)), actual = Buffer.from(sig);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return id;
}
// Origins allowed to talk to this server from another site (the Rooms page). Comma list, or * for any.
const ROOMS_ORIGINS = String(process.env.ROOMS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
function originAllowed(origin) { return ROOMS_ORIGINS.includes('*') || ROOMS_ORIGINS.includes(origin); }
function setGuestCookie(res, id) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(id + '.' + guestSignature(id))}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=31536000'
  ];
  if (NODE_ENV === 'production') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
function defaultGuestName(id) { return `WhimGuest-${id.replace(/-/g, '').slice(0, 4).toUpperCase()}`; }
function validDisplayName(value) {
  const s = cleanText(value, 24);
  return s.length >= 2 && /^[\p{L}\p{N}_ .-]+$/u.test(s) ? s : null;
}
function uniqueDisplayName(value, guestId) {
  const base = validDisplayName(value) || defaultGuestName(guestId);
  const taken = name => [...guests.values()].some(g => g.id !== guestId && g.socketIds.size > 0 && g.username.toLocaleLowerCase() === name.toLocaleLowerCase());
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 24 - suffix.length) + suffix;
    if (!taken(candidate)) return candidate;
  }
  return defaultGuestName(guestId);
}
function getOrCreateGuest(id, preferredName) {
  let guest = guests.get(id);
  if (!guest) {
    guest = { id, username: uniqueDisplayName(preferredName, id), socketIds: new Set(), lastSeen: Date.now() };
    guests.set(id, guest);
  } else if (preferredName && validDisplayName(preferredName) && guest.username !== preferredName) {
    guest.username = uniqueDisplayName(preferredName, id);
  }
  guest.lastSeen = Date.now();
  for (const c of conversations.values()) {
    if (c.kind === 'dm' && c.participants.includes(id)) c.names[id] = guest.username;
  }
  return guest;
}
function requestGuest(req, res, preferredName) {
  let id = cookieGuestId(req.headers.cookie || '');
  if (!id) {
    id = makeId();
    setGuestCookie(res, id);
  }
  const guest = getOrCreateGuest(id, preferredName);
  return guest;
}
function socketGuestId(socket) { return tokenGuestId(socket.handshake.auth && socket.handshake.auth.token) || cookieGuestId(socket.handshake.headers.cookie || ''); }
function formatMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId || null,
    username: row.username || (row.role === 'assistant' ? 'API Buddy' : 'Guest'),
    role: row.role || 'user',
    text: row.text,
    createdAt: row.createdAt,
    time: new Date(row.createdAt).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
  };
}
function getMessageList(conversationId) {
  if (!messageHistory.has(conversationId)) messageHistory.set(conversationId, []);
  return messageHistory.get(conversationId);
}
function getRecentMessages(conversationId, limit = 80) {
  return getMessageList(conversationId).slice(-limit);
}
function insertMessage(conversation, senderId, body, role = 'user') {
  const sender = senderId ? guests.get(senderId) : null;
  const row = formatMessage({
    id: makeId(), conversationId: conversation.id, senderId: senderId || null,
    username: sender ? sender.username : (role === 'assistant' ? 'API Buddy' : 'Guest'),
    role, text: body, createdAt: new Date().toISOString()
  });
  const list = getMessageList(conversation.id);
  list.push(row);
  if (list.length > MAX_MESSAGES_PER_CONVERSATION) list.splice(0, list.length - MAX_MESSAGES_PER_CONVERSATION);
  return row;
}
function makeConversation(id, kind, properties = {}) {
  let c = conversations.get(id);
  if (!c) {
    c = { id, kind, ...properties, createdAt: Date.now() };
    conversations.set(id, c);
    getMessageList(id);
  }
  return c;
}
function getGlobalConversation() { return makeConversation('global', 'global'); }
function getOrCreateGameConversation(slug) {
  if (!GAME_SLUGS.has(slug)) return null;
  return makeConversation(`game:${slug}`, 'game', { gameSlug: slug });
}
function getOrCreateBuddyConversation(guestId) {
  return makeConversation(`buddy:${guestId}`, 'buddy', { ownerId: guestId });
}
function getOrCreateDm(guestIdA, guestIdB) {
  const participants = [guestIdA, guestIdB].sort();
  const id = `dm:${participants[0]}:${participants[1]}`;
  const names = {};
  for (const personId of participants) names[personId] = guests.get(personId)?.username || `Guest-${personId.slice(0, 4)}`;
  const c = makeConversation(id, 'dm', { participants, names });
  c.names = { ...c.names, ...names };
  return c;
}
function getConversation(id) {
  const key = String(id || '');
  if (!key || key.length > 110) return null;
  if (conversations.has(key)) return conversations.get(key);
  if (key === 'global') return getGlobalConversation();
  if (key.startsWith('game:')) return getOrCreateGameConversation(key.slice(5));
  if (key.startsWith('buddy:')) {
    const ownerId = key.slice(6);
    if (!isId(ownerId)) return null;
    return getOrCreateBuddyConversation(ownerId);
  }
  const match = key.match(/^dm:([a-f0-9-]{36}):([a-f0-9-]{36})$/i);
  if (match && isId(match[1]) && isId(match[2]) && match[1] !== match[2]) return getOrCreateDm(match[1], match[2]);
  return null;
}
function canAccessConversation(conversation, guestId) {
  if (!conversation) return false;
  if (conversation.kind === 'global' || conversation.kind === 'game') return true;
  if (conversation.kind === 'buddy') return conversation.ownerId === guestId;
  if (conversation.kind === 'dm') return conversation.participants.includes(guestId);
  return false;
}
function listDms(guestId) {
  return [...conversations.values()]
    .filter(c => c.kind === 'dm' && c.participants.includes(guestId))
    .map(c => {
      const partnerId = c.participants.find(id => id !== guestId);
      return { id: c.id, partnerId, username: guests.get(partnerId)?.username || c.names?.[partnerId] || `Guest-${String(partnerId).slice(0, 4)}` };
    })
    .sort((a, b) => a.username.localeCompare(b.username));
}
function listOnlinePlayers(excludeId) {
  return [...guests.values()]
    .filter(g => g.id !== excludeId && g.socketIds.size > 0)
    .map(g => ({ id: g.id, username: g.username, online: true }))
    .sort((a, b) => a.username.localeCompare(b.username));
}
function requireGuest(req, res, next) {
  try { req.guest = requestGuest(req, res); next(); }
  catch (error) { next(error); }
}
function sameOriginForWrites(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get('host')) return jsonError(res, 403, 'Cross-origin request blocked.');
  } catch (_) { return jsonError(res, 403, 'Invalid request origin.'); }
  next();
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  serveClient: true,
  cors: { origin: (origin, cb) => cb(null, !origin || originAllowed(origin)) },
  maxHttpBufferSize: 1e6,
  pingInterval: 25000,
  pingTimeout: 20000
});
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---- Orphic Realms main site: the game page (game.html) and its pictures (folder a/) are served from this same server ----
// Chat stays available at /?window=popup (and /adopt), exactly as before.
let GAME_GZ = null, GAME_TAG = null;
try {
  const raw = fs.readFileSync(path.join(__dirname, 'game.html'));
  GAME_GZ = zlib.gzipSync(raw, { level: 9 });
  GAME_TAG = '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"';
  console.log('Orphic Realms game page loaded (' + Math.round(raw.length / 1048576) + ' MB, ' + Math.round(GAME_GZ.length / 1048576) + ' MB compressed)');
} catch (e) { console.error('game.html not found next to server.js; the chat page will be shown instead:', e.message); }
// the pictures come from the bundle files only, nothing else in the repository
const PICS = new Map(); // picture path -> bytes, unpacked from pictures1.bin, pictures2.bin, ...
for (const f of fs.readdirSync(__dirname).filter(n => /^pictures\d+\.bin$/.test(n)).sort()) {
  try {
    const buf = fs.readFileSync(path.join(__dirname, f));
    if (buf.toString('latin1', 0, 4) !== 'ORPK') throw new Error('not a picture bundle');
    const hl = buf.readUInt32LE(4), index = JSON.parse(buf.toString('utf8', 8, 8 + hl)), base = 8 + hl;
    let n = 0;
    for (const [p, [off, len]] of Object.entries(index)) { if (base + off + len > buf.length) continue; PICS.set(p, buf.subarray(base + off, base + off + len)); n++; }
    console.log(f + ': ' + n + ' pictures ready');
  } catch (e) { console.error('Could not read ' + f + ' (' + e.message + '). Pictures from this file will be blank.'); }
}
const PIC_TYPES = { webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif' };
app.get(/^\/(p\d\d\/[A-Za-z0-9_.-]+)$/, (req, res, next) => {
  const buf = PICS.get(req.params[0]); if (!buf) return res.sendStatus(404);
  res.set({ 'Content-Type': PIC_TYPES[req.params[0].split('.').pop()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=604800, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
});
app.get('/', (req, res, next) => {
  if (!GAME_GZ || req.query.window === 'popup') return next();
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'ETag': GAME_TAG, 'Vary': 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff' });
  if (req.get('if-none-match') === GAME_TAG) return res.status(304).end();
  if (/\bgzip\b/.test(req.get('accept-encoding') || '')) { res.set('Content-Encoding', 'gzip'); return res.end(GAME_GZ); }
  zlib.gunzip(GAME_GZ, (err, raw) => err ? next(err) : res.end(raw));
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
      scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'], connectSrc: ["'self'", 'wss:', 'https:'],
      upgradeInsecureRequests: NODE_ENV === 'production' ? [] : null
    }
  }, crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '25kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use('/api', sameOriginForWrites);
// Serve only the three intended browser assets from the repository root.
// Avoid mounting the entire repository as static content (which could expose config/code files).
const assetCache = NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-store';
app.get('/', (_req, res, next) => {
  res.set('Cache-Control', assetCache);
  res.sendFile(path.join(__dirname, 'index.html'), err => { if (err) next(err); });
});
app.get('/index.html', (_req, res, next) => {
  res.set('Cache-Control', assetCache);
  res.sendFile(path.join(__dirname, 'index.html'), err => { if (err) next(err); });
});
app.get('/app.js', (_req, res, next) => {
  res.type('application/javascript').set('Cache-Control', assetCache);
  res.sendFile(path.join(__dirname, 'app.js'), err => { if (err) next(err); });
});
app.get('/style.css', (_req, res, next) => {
  res.type('text/css').set('Cache-Control', assetCache);
  res.sendFile(path.join(__dirname, 'style.css'), err => { if (err) next(err); });
});

const messageLimiter = rateLimit({ windowMs: 10 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Please slow down a little before sending more messages.' } });
const buddyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Buddy is getting a little overwhelmed. Try again in a moment.' } });

async function resolveBuddyEndpoint(endpointValue) {
  const raw = String(endpointValue || 'https://api.openai.com/v1/chat/completions').trim();
  let url;
  try { url = new URL(raw); } catch (_) { throw new Error('Enter a valid HTTPS API endpoint.'); }
  if (url.protocol !== 'https:') throw new Error('The Buddy API endpoint must use HTTPS.');
  const hosts = new Set(String(process.env.BUDDY_ALLOWED_HOSTS || 'api.openai.com').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  if (!hosts.has(url.hostname.toLowerCase())) throw new Error('This API host is not enabled on this Communicator server yet. Add its exact hostname to BUDDY_ALLOWED_HOSTS in Render settings, or use the default provider.');
  if (url.username || url.password) throw new Error('Do not put credentials inside the endpoint URL.');
  return url.toString();
}

// ---- Rooms (the 3D site) bridge: token identity so it works across sites without cookies ----
app.use('/rooms-api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && originAllowed(origin)) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS').set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.post('/rooms-api/guest', (req, res) => {
  let id = tokenGuestId(req.body && req.body.token);
  if (!id) id = makeId();
  const guest = getOrCreateGuest(id, req.body && req.body.username);
  res.set('Cache-Control', 'no-store').json({ token: guestToken(id), user: { id: guest.id, username: guest.username } });
});
// Opens the chat window as the same guest the Rooms page is using, then lands on the normal chat page.
app.get('/adopt', (req, res) => {
  const id = tokenGuestId(req.query.t);
  if (id) { setGuestCookie(res, id); getOrCreateGuest(id); }
  res.redirect(302, '/?window=popup');
});
app.get('/health', (_req, res) => res.json({ ok: true, service: 'realms-chat', version: '1.3.0-orphic', accounts: false, database: false }));
app.post('/api/guest', (req, res) => {
  const guest = requestGuest(req, res, req.body?.username);
  res.set('Cache-Control', 'no-store').json({ user: { id: guest.id, username: guest.username } });
});
app.get('/api/me', (req, res) => {
  const guestId = cookieGuestId(req.headers.cookie || '');
  if (!guestId) return jsonError(res, 401, 'Guest identity not initialized.');
  const guest = getOrCreateGuest(guestId);
  res.set('Cache-Control', 'no-store').json({ user: { id: guest.id, username: guest.username } });
});
app.post('/api/guest/profile', (req, res, next) => {
  try {
    const guest = requestGuest(req, res);
    const username = validDisplayName(req.body?.username);
    if (!username) return jsonError(res, 400, 'Display names must be 2–24 characters using letters, numbers, spaces, underscores, dots, or hyphens.');
    const other = [...guests.values()].find(g => g.id !== guest.id && g.socketIds.size > 0 && g.username.toLocaleLowerCase() === username.toLocaleLowerCase());
    if (other) return jsonError(res, 409, 'That display name is already in use by someone online. Try a small variation.');
    guest.username = username;
    for (const c of conversations.values()) if (c.kind === 'dm' && c.participants.includes(guest.id)) c.names[guest.id] = username;
    res.json({ user: { id: guest.id, username: guest.username } });
  } catch (error) { next(error); }
});
app.get('/api/bootstrap', requireGuest, (req, res) => {
  const guest = req.guest;
  const global = getGlobalConversation();
  const buddy = getOrCreateBuddyConversation(guest.id);
  res.set('Cache-Control', 'no-store').json({
    user: { id: guest.id, username: guest.username }, globalConversationId: global.id,
    buddyConversationId: buddy.id, games: GAME_LIST, dms: listDms(guest.id),
    persistence: 'temporary-server-memory-with-browser-local-cache'
  });
});
app.get('/api/games/:slug', requireGuest, (req, res) => {
  const conversation = getOrCreateGameConversation(req.params.slug);
  if (!conversation) return jsonError(res, 404, 'That game channel is not configured.');
  res.json({ id: conversation.id, kind: 'game', gameSlug: req.params.slug });
});
app.get('/api/players', requireGuest, (req, res) => {
  res.set('Cache-Control', 'no-store').json({ players: listOnlinePlayers(req.guest.id) });
});
app.get('/api/conversations/:id/messages', requireGuest, (req, res) => {
  const conversation = getConversation(req.params.id);
  if (!canAccessConversation(conversation, req.guest.id)) return jsonError(res, 403, 'You cannot read that conversation.');
  res.set('Cache-Control', 'no-store').json({ messages: getRecentMessages(conversation.id) });
});
app.post('/api/dms', requireGuest, (req, res) => {
  const guest = req.guest;
  let partner = null;
  const partnerId = String(req.body?.partnerId || '');
  if (isId(partnerId)) partner = guests.get(partnerId) || null;
  else {
    const username = cleanText(req.body?.username, 24);
    const matches = [...guests.values()].filter(g => g.id !== guest.id && g.socketIds.size > 0 && g.username.toLocaleLowerCase() === username.toLocaleLowerCase());
    if (matches.length > 1) return jsonError(res, 409, 'More than one online guest uses that name. Ask them to choose distinct display names.');
    partner = matches[0] || null;
  }
  if (!partner || partner.id === guest.id || partner.socketIds.size === 0) return jsonError(res, 404, 'That person is not online right now. Ask them to open realms.chat, then refresh the player list.');
  const conversation = getOrCreateDm(guest.id, partner.id);
  io.to(`user:${partner.id}`).emit('dm:updated', { partnerId: guest.id, username: guest.username, conversationId: conversation.id });
  res.json({ conversation: { id: conversation.id, kind: 'dm', partnerId: partner.id, username: partner.username } });
});
app.get('/api/dms', requireGuest, (req, res) => res.json({ dms: listDms(req.guest.id) }));
app.post('/api/buddy/chat', requireGuest, buddyLimiter, async (req, res, next) => {
  try {
    const guest = req.guest;
    const conversation = getOrCreateBuddyConversation(guest.id);
    if (req.body?.conversationId && String(req.body.conversationId) !== conversation.id) return jsonError(res, 403, 'That Buddy conversation does not belong to this guest.');
    const text = cleanText(req.body?.text, 1500);
    const apiKey = String(req.body?.apiKey || '').trim();
    const model = cleanText(req.body?.model, 120);
    if (!text) return jsonError(res, 400, 'Write a message first.');
    if (!apiKey || apiKey.length > 500) return jsonError(res, 400, 'Open Options and enter your Buddy API key for this page session.');
    if (!model) return jsonError(res, 400, 'Open Options and enter the model name.');
    const endpoint = await resolveBuddyEndpoint(req.body?.endpoint);
    const prior = getRecentMessages(conversation.id, 20);
    const history = prior.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));
    history.push({ role: 'user', content: text });
    const response = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [
        { role: 'system', content: 'You are an optional companion inside Orphic Realms: warm, curious, gently whimsical, clever, respectful, and concise. Help with games, creative exploration, and conversation. Do not claim to control the website or other players.' },
        ...history
      ], temperature: 0.8 }), signal: AbortSignal.timeout(45000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const providerMessage = cleanText(data?.error?.message || data?.message || '', 300);
      return jsonError(res, 502, providerMessage ? `Buddy provider: ${providerMessage}` : `Buddy provider returned HTTP ${response.status}.`);
    }
    const reply = cleanText(data?.choices?.[0]?.message?.content, 4000);
    if (!reply) return jsonError(res, 502, 'The Buddy provider returned an empty response. Check the selected model and endpoint.');
    const userMessage = insertMessage(conversation, guest.id, text, 'user');
    const buddyMessage = insertMessage(conversation, null, reply, 'assistant');
    io.to(`user:${guest.id}`).emit('message:new', userMessage);
    io.to(`user:${guest.id}`).emit('message:new', buddyMessage);
    res.json({ messages: [userMessage, buddyMessage] });
  } catch (error) {
    if (error.message && (error.message.includes('endpoint') || error.message.includes('hostname') || error.message.includes('HTTPS') || error.message.includes('BUDDY_ALLOWED_HOSTS'))) return jsonError(res, 400, error.message);
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return jsonError(res, 504, 'Buddy took too long to respond. Try again.');
    next(error);
  }
});
app.get('/api/rtc-config', (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const turnUrls = String(process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  const username = process.env.TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL;
  if (turnUrls.length && username && credential) iceServers.push({ urls: turnUrls, username, credential });
  res.set('Cache-Control', 'no-store').json({ iceServers });
});

io.use((socket, next) => {
  const guestId = socketGuestId(socket);
  if (!guestId) return next(new Error('Guest identity is missing. Refresh the page and reconnect.'));
  socket.guestId = guestId;
  next();
});
io.on('connection', socket => {
  const guest = getOrCreateGuest(socket.guestId);
  guest.socketIds.add(socket.id);
  guest.lastSeen = Date.now();
  socket.join(`user:${guest.id}`);
  io.emit('presence:changed', { count: [...guests.values()].filter(g => g.socketIds.size > 0).length });

  socket.on('conversation:join', (payload = {}, ack = () => {}) => {
    const conversation = getConversation(String(payload.conversationId || ''));
    if (!canAccessConversation(conversation, socket.guestId)) return ack({ ok: false, error: 'You cannot join that conversation.' });
    socket.join(`conversation:${conversation.id}`);
    ack({ ok: true });
  });
  socket.on('conversation:leave', (payload = {}, ack = () => {}) => {
    const conversation = getConversation(String(payload.conversationId || ''));
    if (!canAccessConversation(conversation, socket.guestId)) return ack({ ok: false });
    socket.leave(`conversation:${conversation.id}`); ack({ ok: true });
  });
  socket.on('message:send', (payload = {}, ack = () => {}) => {
    const now = Date.now();
    socket.messageTimestamps = (socket.messageTimestamps || []).filter(time => now - time < 10000);
    if (socket.messageTimestamps.length >= 20) return ack({ ok: false, error: 'Please slow down a little before sending more messages.' });
    socket.messageTimestamps.push(now);
    const conversation = getConversation(String(payload.conversationId || ''));
    const text = cleanText(payload.text, 2000);
    if (!conversation || !text) return ack({ ok: false, error: 'Write a message first.' });
    if (!canAccessConversation(conversation, socket.guestId)) return ack({ ok: false, error: 'You cannot send to that conversation.' });
    if (conversation.kind === 'buddy') return ack({ ok: false, error: 'Use the Buddy API connection for this channel.' });
    const message = insertMessage(conversation, socket.guestId, text, 'user');
    io.to(`conversation:${conversation.id}`).emit('message:new', message);
    if (conversation.kind === 'dm') {
      const otherId = conversation.participants.find(id => id !== socket.guestId);
      if (otherId) io.to(`user:${otherId}`).emit('dm:updated', { partnerId: socket.guestId, username: guests.get(socket.guestId)?.username || 'Guest', conversationId: conversation.id });
    }
    ack({ ok: true, message });
  });

  // ---- Rooms presence: who is in which room, where they stand, what they say ----
  const roomOf = () => socket.roomsRoom;
  const me = () => ({ id: guest.id, name: guest.username, look: socket.roomsLook || null, ...(socket.roomsPos || {}) });
  function leaveRoomsRoom() {
    if (socket.grabbing) { const s2 = io.sockets.sockets.get(socket.grabbing); if (s2) { s2.grabbedBy = null; s2.emit('rooms:released', { by: guest.id }); } socket.grabbing = null; }
    if (socket.grabbedBy) { const g = [...io.sockets.sockets.values()].find(x => x.guestId === socket.grabbedBy); if (g) { g.grabbing = null; g.emit('rooms:released', { by: guest.id }); } socket.grabbedBy = null; }
    if (!socket.roomsRoom) return;
    const r = socket.roomsRoom; socket.leave('rm:' + r); socket.roomsRoom = null;
    socket.to('rm:' + r).emit('rooms:leave', { id: guest.id });
  }
  socket.on('rooms:join', (payload = {}, ack = () => {}) => {
    const room = cleanText(payload.room, 40).toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(room)) return ack({ ok: false });
    if (payload.name) { const g = getOrCreateGuest(guest.id, payload.name); void g; }
    leaveRoomsRoom();
    socket.roomsRoom = room; socket.roomsPos = { x: Number(payload.x) || 0, y: Number(payload.y) || 0, layer: 0, face: 1, pose: 'idle' };
    const look = payload.look && typeof payload.look === 'object' ? payload.look : null;
    socket.roomsLook = look ? { c: cleanText(look.c, 9), creature: cleanText(look.creature, 40) } : null;
    const others = [];
    for (const sid of io.sockets.adapter.rooms.get('rm:' + room) || []) {
      const s2 = io.sockets.sockets.get(sid);
      if (s2 && s2.guestId !== guest.id) others.push({ id: s2.guestId, name: guests.get(s2.guestId)?.username || 'Guest', look: s2.roomsLook || null, ...(s2.roomsPos || {}) });
    }
    socket.join('rm:' + room);
    socket.to('rm:' + room).emit('rooms:join', me());
    ack({ ok: true, you: { id: guest.id, name: guest.username }, players: others.slice(0, 60) });
  });
  socket.on('rooms:move', (p = {}) => {
    if (!roomOf()) return;
    const now = Date.now(); if (socket.lastMove && now - socket.lastMove < 40) return; socket.lastMove = now;
    const n = v => Math.max(-500, Math.min(500, Number(v) || 0));
    socket.roomsPos = { x: n(p.x), y: n(p.y), layer: Math.max(0, Math.min(2, p.layer | 0)), face: p.face < 0 ? -1 : 1, pose: ['idle', 'walk', 'jump'].includes(p.pose) ? p.pose : 'idle' };
    socket.volatile.to('rm:' + roomOf()).emit('rooms:move', { id: guest.id, ...socket.roomsPos });
  });
  socket.on('rooms:say', (p = {}, ack = () => {}) => {
    if (!roomOf()) return ack({ ok: false });
    const now = Date.now();
    socket.messageTimestamps = (socket.messageTimestamps || []).filter(t => now - t < 10000);
    if (socket.messageTimestamps.length >= 20) return ack({ ok: false, error: 'Slow down a little.' });
    socket.messageTimestamps.push(now);
    const text = cleanText(p.text, 140); if (!text) return ack({ ok: false });
    socket.to('rm:' + roomOf()).emit('rooms:say', { id: guest.id, name: guest.username, text });
    // the same line also lands in the realm-wide chat window, tagged with the room it was said in
    const msg = insertMessage(getGlobalConversation(), guest.id, text, 'user');
    io.to('conversation:global').emit('message:new', msg);
    ack({ ok: true });
  });
  // Shared music: what one player plays in a room (piano keys, chord pads) is relayed to everyone else standing in that room, so they all hear it live.
  const NOTE_KINDS = new Set(['pixel', 'chime', 'synth']), CHORD_TYPES = new Set(['maj', 'min', '7', 'maj7', 'min7', 'sus4', 'dim', 'add9', 'aug']);
  socket.on('rooms:note', (p = {}) => {
    const room = roomOf(); if (!room || !p || typeof p !== 'object') return;
    const now = Date.now(); socket.noteTimes = (socket.noteTimes || []).filter(t => now - t < 1000);
    if (socket.noteTimes.length >= 40) return; socket.noteTimes.push(now); // at most 40 notes a second per player
    const k = NOTE_KINDS.has(p.k) ? p.k : 'pixel', m = Math.round(Number(p.m));
    if (!Number.isFinite(m) || m < 12 || m > 108) return;
    if (p.t === 'on' || p.t === 'off') socket.to('rm:' + room).emit('rooms:note', { id: guest.id, t: p.t, m, k });
    else if (p.t === 'chord' && CHORD_TYPES.has(p.c)) socket.to('rm:' + room).emit('rooms:note', { id: guest.id, t: 'chord', m, c: p.c, k });
  });
  // Grab and pull: one player takes hold of another in the same room; the grabbed player's page follows the grabber.
  function targetSocket(id) { for (const sid of io.sockets.adapter.rooms.get('rm:' + roomOf()) || []) { const s2 = io.sockets.sockets.get(sid); if (s2 && s2.guestId === id) return s2; } return null; }
  function releaseGrab(notify = true) {
    const t = socket.grabbing; if (!t) return; socket.grabbing = null;
    const s2 = io.sockets.sockets.get(t); if (s2 && s2.grabbedBy === guest.id) { s2.grabbedBy = null; if (notify) s2.emit('rooms:released', { by: guest.id }); }
    if (notify) socket.emit('rooms:released', { by: guest.id, target: s2 ? s2.guestId : null });
  }
  socket.on('rooms:grab', (p = {}, ack = () => {}) => {
    if (!roomOf()) return ack({ ok: false });
    const id = String(p.targetId || ''), t = id !== guest.id ? targetSocket(id) : null;
    if (!t) return ack({ ok: false, error: 'They are not here.' });
    if (t.grabbedBy && t.grabbedBy !== guest.id) return ack({ ok: false, error: 'Someone is already holding on to them.' });
    if (t.grabbing === guest.id) return ack({ ok: false, error: 'They are holding on to you.' });
    releaseGrab(); socket.grabbing = t.id; t.grabbedBy = guest.id;
    t.emit('rooms:grabbed', { by: guest.id, name: guest.username });
    ack({ ok: true, name: guests.get(t.guestId)?.username });
  });
  socket.on('rooms:release', () => releaseGrab());
  socket.on('rooms:leave', () => { releaseGrab(); leaveRoomsRoom(); });

  socket.on('call:invite', (payload = {}, ack = () => {}) => {
    const conversation = getConversation(String(payload.conversationId || ''));
    if (!conversation || conversation.kind !== 'dm' || !canAccessConversation(conversation, socket.guestId)) return ack({ ok: false, error: 'Calls can only start inside a private conversation.' });
    const toUserId = String(payload.toUserId || '');
    const expectedOther = conversation.participants.find(id => id !== socket.guestId);
    if (toUserId !== expectedOther) return ack({ ok: false, error: 'That call recipient does not match this private conversation.' });
    const targetRoom = io.sockets.adapter.rooms.get(`user:${toUserId}`);
    if (!targetRoom || targetRoom.size === 0) return ack({ ok: false, error: 'That person is not online in realms.chat right now.' });
    const callId = String(payload.callId || '');
    if (!callId || activeCalls.has(callId)) return ack({ ok: false, error: 'Call ID is invalid or already exists.' });
    const callerName = guests.get(socket.guestId)?.username || 'Guest';
    const mode = payload.mode === 'video' ? 'video' : 'audio';
    const call = { id: callId, callerId: socket.guestId, recipientId: toUserId, conversationId: conversation.id, callerName, mode, accepted: false, timeout: null };
    call.timeout = setTimeout(() => {
      if (!activeCalls.has(call.id)) return;
      io.to(`user:${call.callerId}`).emit('call:ended', { callId: call.id, reason: 'no-answer' });
      io.to(`user:${call.recipientId}`).emit('call:ended', { callId: call.id, reason: 'no-answer' });
      activeCalls.delete(call.id);
    }, 45000);
    activeCalls.set(call.id, call);
    io.to(`user:${toUserId}`).emit('call:incoming', { callId: call.id, fromUserId: socket.guestId, fromUsername: callerName, conversationId: conversation.id, mode });
    ack({ ok: true });
  });
  socket.on('call:accept', (payload = {}, ack = () => {}) => {
    const call = activeCalls.get(String(payload.callId || ''));
    if (!call || call.recipientId !== socket.guestId || call.accepted) return ack({ ok: false, error: 'This invitation is no longer available or has already been accepted.' });
    call.accepted = true; clearTimeout(call.timeout);
    io.to(`user:${call.callerId}`).emit('call:accepted', { callId: call.id, byUserId: socket.guestId });
    ack({ ok: true });
  });
  socket.on('call:signal', (payload = {}, ack = () => {}) => {
    const call = activeCalls.get(String(payload.callId || ''));
    if (!call || !call.accepted) return ack({ ok: false, error: 'The call is not active yet.' });
    if (socket.guestId !== call.callerId && socket.guestId !== call.recipientId) return ack({ ok: false, error: 'You are not part of this call.' });
    const targetUserId = socket.guestId === call.callerId ? call.recipientId : call.callerId;
    const type = String(payload.type || '');
    if (!['offer', 'answer', 'candidate'].includes(type)) return ack({ ok: false, error: 'Unknown call signal.' });
    io.to(`user:${targetUserId}`).emit('call:signal', { callId: call.id, fromUserId: socket.guestId, type, data: payload.data });
    ack({ ok: true });
  });
  function finishCall(callId, reason) {
    const call = activeCalls.get(String(callId || ''));
    if (!call || (socket.guestId !== call.callerId && socket.guestId !== call.recipientId)) return false;
    clearTimeout(call.timeout); activeCalls.delete(call.id);
    const other = socket.guestId === call.callerId ? call.recipientId : call.callerId;
    io.to(`user:${other}`).emit('call:ended', { callId: call.id, reason: reason || 'ended', byUserId: socket.guestId });
    return true;
  }
  socket.on('call:decline', (payload = {}, ack = () => {}) => ack({ ok: finishCall(payload.callId, 'declined') }));
  socket.on('call:end', (payload = {}, ack = () => {}) => ack({ ok: finishCall(payload.callId, 'ended') }));
  socket.on('disconnect', () => {
    leaveRoomsRoom();
    guest.socketIds.delete(socket.id); guest.lastSeen = Date.now();
    for (const [id, call] of activeCalls) {
      if (call.callerId === guest.id || call.recipientId === guest.id) {
        clearTimeout(call.timeout); activeCalls.delete(id);
        const other = call.callerId === guest.id ? call.recipientId : call.callerId;
        io.to(`user:${other}`).emit('call:ended', { callId: call.id, reason: 'connection-lost' });
      }
    }
    io.emit('presence:changed', { count: [...guests.values()].filter(g => g.socketIds.size > 0).length });
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.use((err, _req, res, _next) => {
  // Never log request bodies or Buddy API keys.
  console.error('Request failed:', err && err.message ? err.message : 'unknown error');
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on the Communicator server. Please try again.' });
});

getGlobalConversation();
for (const game of GAME_LIST) getOrCreateGameConversation(game.slug);
server.listen(PORT, '0.0.0.0', () => console.log(`realms.chat guest beta listening on ${PORT} (no accounts, no database)`));

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
