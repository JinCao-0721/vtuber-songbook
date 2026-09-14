import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = path.join(root, 'data', 'songs.json');
const usersFile = path.join(root, 'data', 'admin-users.json');
const publicDir = path.join(root, 'public');
const adminHtml = path.join(root, 'server', 'admin.html');
const port = Number(process.env.ADMIN_PORT || 4322);
const siteId = process.env.SITE_ID || 'ii7';
const qqCookieFile = process.env.QQMUSIC_COOKIE_FILE || path.join(root, 'qqmusic_cookie.txt');
const sessions = new Map();
const execFileAsync = promisify(execFile);

async function readSongs() {
  return JSON.parse(await fs.readFile(dataFile, 'utf8'));
}

async function writeSongs(songs) {
  const temp = `${dataFile}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(songs, null, 2)}\n`, 'utf8');
  await fs.rename(temp, dataFile);
}

async function readUsers() {
  try { return JSON.parse(await fs.readFile(usersFile, 'utf8')); }
  catch { return []; }
}

async function writeUsers(users) {
  const temp = `${usersFile}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(users, null, 2)}\n`, 'utf8');
  await fs.rename(temp, usersFile);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, encoded) {
  const [, salt64, hash64] = String(encoded || '').split('$');
  if (!salt64 || !hash64) return false;
  const actual = crypto.scryptSync(password, Buffer.from(salt64, 'base64'), 64);
  const expected = Buffer.from(hash64, 'base64');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function auth(req, res, next) {
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '') || req.cookies?.session;
  const session = token && sessions.get(token);
  if (!session) return res.status(401).json({ error: '未登录' });
  req.user = session;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user?.role) ? next() : res.status(403).json({ error: '权限不足' });
}

function cleanSlug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/media', express.static(path.join(publicDir, 'media')));
app.get('/admin', async (req, res) => res.type('html').send(await fs.readFile(adminHtml, 'utf8')));
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.post('/api/auth/login', (req, res) => {
  return readUsers().then((users) => {
    const username = String(req.body?.username || '').trim();
    const user = users.find((item) => item.username === username && item.active !== false);
    if (!user || !verifyPassword(String(req.body?.password || ''), user.passwordHash)) return res.status(401).json({ error: '账号或密码错误' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username: user.username, role: user.role, createdAt: Date.now() });
    res.json({ token, user: { username: user.username, role: user.role } });
  }).catch((error) => res.status(500).json({ error: error.message }));
});

app.get('/api/me', auth, (req, res) => res.json(req.user));

app.post('/api/auth/logout', auth, (req, res) => {
  const token = req.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (token) sessions.delete(token);
  res.status(204).end();
});

app.get('/api/songs', auth, async (req, res, next) => {
  try { res.json((await readSongs()).filter((song) => song.vupId === siteId)); } catch (error) { next(error); }
});

app.get('/api/users', auth, requireRole('owner'), async (req, res, next) => {
  try { res.json((await readUsers()).map(({ passwordHash, ...user }) => user)); } catch (error) { next(error); }
});

app.post('/api/users', auth, requireRole('owner'), async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const role = ['owner', 'editor', 'viewer'].includes(req.body?.role) ? req.body.role : 'viewer';
    const userPassword = String(req.body?.password || '');
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username) || userPassword.length < 8) return res.status(400).json({ error: '账号至少 3 位，密码至少 8 位' });
    const users = await readUsers();
    if (users.some((user) => user.username === username)) return res.status(409).json({ error: '账号已存在' });
    const user = { username, role, active: true, passwordHash: hashPassword(userPassword) };
    users.push(user); await writeUsers(users);
    res.status(201).json({ username, role, active: true });
  } catch (error) { next(error); }
});

app.put('/api/users/:username', auth, requireRole('owner'), async (req, res, next) => {
  try {
    const users = await readUsers(); const user = users.find((item) => item.username === req.params.username);
    if (!user) return res.status(404).json({ error: '账号不存在' });
    if (req.body?.role && ['owner', 'editor', 'viewer'].includes(req.body.role)) user.role = req.body.role;
    if (typeof req.body?.active === 'boolean') user.active = req.body.active;
    if (req.body?.password) { if (String(req.body.password).length < 8) return res.status(400).json({ error: '密码至少 8 位' }); user.passwordHash = hashPassword(String(req.body.password)); }
    await writeUsers(users); res.json({ username: user.username, role: user.role, active: user.active });
  } catch (error) { next(error); }
});

app.delete('/api/users/:username', auth, requireRole('owner'), async (req, res, next) => {
  try {
    if (req.params.username === req.user.username) return res.status(400).json({ error: '不能删除当前登录账号' });
    const users = await readUsers(); const nextUsers = users.filter((item) => item.username !== req.params.username);
    if (nextUsers.length === users.length) return res.status(404).json({ error: '账号不存在' });
    if (!nextUsers.some((item) => item.role === 'owner')) return res.status(400).json({ error: '至少保留一个 owner' });
    await writeUsers(nextUsers); res.status(204).end();
  } catch (error) { next(error); }
});

app.post('/api/qq/playlist', auth, requireRole('owner', 'editor'), async (req, res, next) => {
  try {
    const playlistId = String(req.body?.playlistId || '').trim();
    if (!/^\d+$/.test(playlistId)) return res.status(400).json({ error: '请输入数字格式的 QQ 歌单 ID' });
    const cookie = await fs.readFile(qqCookieFile, 'utf8').catch(() => '');
    const query = new URLSearchParams({ type: '1', json: '1', utf8: '1', onlysong: '0', disstid: playlistId, format: 'json', g_tk: '5381', loginUin: '0', hostUin: '0', inCharset: 'utf8', outCharset: 'utf-8', platform: 'yqq', needNewCode: '0' });
    const response = await fetch(`https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?${query}`, { headers: { Referer: `https://y.qq.com/n/ryqq/playlist/${playlistId}`, Cookie: cookie, 'User-Agent': 'Mozilla/5.0' } });
    const text = await response.text();
    const payload = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const playlist = payload.cdlist?.[0];
    if (!playlist) return res.status(404).json({ error: '找不到歌单，或歌单需要可用的 QQ Cookie' });
    res.json({ playlistId, name: playlist.dissname, songs: (playlist.songlist || []).map((song) => ({ title: song.songname, artist: (song.singer || []).map((item) => item.name).join(' / '), songMid: song.songmid, duration: formatDuration(song.interval), qqUrl: `https://y.qq.com/n/ryqq/songDetail/${song.songmid}` })) });
  } catch (error) { next(error); }
});

app.post('/api/songs/from-qq', auth, requireRole('owner', 'editor'), async (req, res, next) => {
  try {
    const playlistId = String(req.body?.playlistId || '').trim();
    const songMid = String(req.body?.songMid || '').trim();
    const bvid = String(req.body?.bvid || '').trim();
    if (!/^\d+$/.test(playlistId) || !songMid || !/^BV[0-9A-Za-z]+$/.test(bvid)) return res.status(400).json({ error: '歌单 ID、歌曲 MID 和 BV 号均必填' });
    const cookie = await fs.readFile(qqCookieFile, 'utf8').catch(() => '');
    const query = new URLSearchParams({ type: '1', json: '1', utf8: '1', onlysong: '0', disstid: playlistId, format: 'json', g_tk: '5381', loginUin: '0', hostUin: '0', inCharset: 'utf8', outCharset: 'utf-8', platform: 'yqq', needNewCode: '0' });
    const response = await fetch(`https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?${query}`, { headers: { Referer: `https://y.qq.com/n/ryqq/playlist/${playlistId}`, Cookie: cookie, 'User-Agent': 'Mozilla/5.0' } });
    const text = await response.text();
    const payload = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const track = payload.cdlist?.[0]?.songlist?.find((song) => song.songmid === songMid);
    if (!track) return res.status(404).json({ error: '歌曲不在指定歌单中' });
    const songs = await readSongs();
    const slug = cleanSlug(track.songname) || `qq-${songMid.toLowerCase()}`;
    const existing = songs.find((song) => song.vupId === siteId && song.qqSongMid === songMid);
    const song = normalizeSong({ ...(existing || {}), slug: existing?.slug || slug, vupId: siteId, title: track.songname, type: existing?.type || '翻唱', artist: existing?.artist || siteId, originalArtist: (track.singer || []).map((item) => item.name).join(' / '), date: existing?.date || new Date().toISOString().slice(0, 10), duration: formatDuration(track.interval), description: existing?.description || `来自 QQ 音乐歌单 ${playlistId}；对应 Bilibili ${bvid}。`, accent: existing?.accent || '#f0a6ca', audio: existing?.audio || [], links: { ...(existing?.links || {}), qq: `https://y.qq.com/n/ryqq/songDetail/${songMid}`, bilibili: `https://www.bilibili.com/video/${bvid}` }, qqPlaylistId: playlistId, qqSongMid: songMid, bilibiliBvid: bvid });
    const index = existing ? songs.indexOf(existing) : -1;
    if (index >= 0) songs[index] = song; else songs.push(song);
    await writeSongs(songs);
    let downloadError;
    try {
      const audio = await downloadBilibiliAudio(song.slug, bvid);
      song.audio = [...(song.audio || []).filter((item) => item.label !== 'VTuber 翻唱'), audio];
      const savedIndex = songs.findIndex((item) => item.slug === song.slug && item.vupId === siteId);
      songs[savedIndex] = song;
      await writeSongs(songs);
    } catch (error) {
      downloadError = error.message;
    }
    res.status(existing ? 200 : 201).json(downloadError ? { ...song, downloadError } : song);
  } catch (error) { next(error); }
});

app.post('/api/songs', auth, requireRole('owner', 'editor'), async (req, res, next) => {
  try {
    const song = normalizeSong(req.body);
    const songs = await readSongs();
    if (songs.some((item) => item.slug === song.slug)) return res.status(409).json({ error: 'slug 已存在' });
    songs.push({ ...song, vupId: siteId });
    await writeSongs(songs);
    res.status(201).json(song);
  } catch (error) { next(error); }
});

app.put('/api/songs/:slug', auth, requireRole('owner', 'editor'), async (req, res, next) => {
  try {
    const songs = await readSongs();
    const index = songs.findIndex((item) => item.slug === req.params.slug && item.vupId === siteId);
    if (index < 0) return res.status(404).json({ error: '歌曲不存在' });
    const song = normalizeSong({ ...songs[index], ...req.body, slug: req.params.slug, audio: req.body.audio ?? songs[index].audio });
    songs[index] = song;
    await writeSongs(songs);
    res.json(song);
  } catch (error) { next(error); }
});

app.delete('/api/songs/:slug', auth, requireRole('owner'), async (req, res, next) => {
  try {
    const songs = await readSongs();
    const nextSongs = songs.filter((item) => !(item.slug === req.params.slug && item.vupId === siteId));
    if (nextSongs.length === songs.length) return res.status(404).json({ error: '歌曲不存在' });
    await writeSongs(nextSongs);
    res.status(204).end();
  } catch (error) { next(error); }
});

function normalizeSong(input) {
  const slug = cleanSlug(input.slug || input.title);
  if (!slug || !input.title) throw new Error('slug 和 title 必填');
  return {
    slug,
    vupId: String(input.vupId || siteId),
    title: String(input.title).trim(),
    type: ['翻唱', '原创', 'BGM'].includes(input.type) ? input.type : '翻唱',
    artist: String(input.artist || '').trim(),
    originalArtist: input.originalArtist ? String(input.originalArtist).trim() : undefined,
    date: String(input.date || new Date().toISOString().slice(0, 10)),
    duration: String(input.duration || ''),
    description: String(input.description || '').trim(),
    accent: /^#[0-9a-f]{6}$/i.test(input.accent || '') ? input.accent : '#f0a6ca',
    audio: Array.isArray(input.audio) ? input.audio : [],
    links: input.links && typeof input.links === 'object' ? input.links : {},
    qqPlaylistId: input.qqPlaylistId ? String(input.qqPlaylistId) : undefined,
    qqSongMid: input.qqSongMid ? String(input.qqSongMid) : undefined,
    bilibiliBvid: input.bilibiliBvid ? String(input.bilibiliBvid) : undefined,
  };
}

function formatDuration(seconds) {
  const total = Number(seconds) || 0;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function downloadBilibiliAudio(slug, bvid) {
  const downloadDir = path.join(root, 'downloads', 'covers');
  await fs.mkdir(downloadDir, { recursive: true });
  const python = process.env.PYTHON || 'python';
  await execFileAsync(python, ['bilibili_download_test.py', '--url', `https://www.bilibili.com/video/${bvid}`, '--audio-quality', '192', '--output', downloadDir], { cwd: root, maxBuffer: 2 * 1024 * 1024 });
  const candidates = (await fs.readdir(downloadDir)).filter((name) => name.includes(bvid) && name.toLowerCase().endsWith('.mp3'));
  if (!candidates.length) throw new Error('下载完成但没有找到 MP3 文件');
  const source = candidates.sort().at(-1);
  const fileName = `${slug}-vtuber-cover.mp3`;
  const destination = path.join(publicDir, 'media', 'covers', fileName);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(path.join(downloadDir, source), destination);
  return { src: `/media/covers/${fileName}`, label: 'VTuber 翻唱', source: `Bilibili ${bvid}` };
}

app.use((error, req, res, next) => {
  console.error(error);
  res.status(400).json({ error: error.message || '请求失败' });
});

app.listen(port, '127.0.0.1', () => console.log(`Admin API: http://127.0.0.1:${port}/admin`));
