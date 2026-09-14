import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'data', 'admin-users.json');
const oldUsername = process.env.OLD_ADMIN_USERNAME || 'admin';
const username = process.env.ADMIN_USERNAME;
const password = process.env.ADMIN_PASSWORD;
if (!username || !password || password.length < 8) throw new Error('请设置 ADMIN_USERNAME 和至少 8 位 ADMIN_PASSWORD');
const users = JSON.parse(await fs.readFile(file, 'utf8'));
const user = users.find((item) => item.username === oldUsername);
if (!user) throw new Error(`找不到账号：${oldUsername}`);
if (username !== oldUsername && users.some((item) => item.username === username)) throw new Error(`目标账号已存在：${username}`);
const salt = crypto.randomBytes(16); const hash = crypto.scryptSync(password, salt, 64);
user.username = username; user.role = 'owner'; user.active = true; user.passwordHash = `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
await fs.writeFile(file, `${JSON.stringify(users, null, 2)}\n`, 'utf8');
console.log(`已更新 owner 账号：${username}`);
