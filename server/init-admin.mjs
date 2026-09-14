import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'data', 'admin-users.json');
const username = process.env.ADMIN_USERNAME || 'admin';
const password = process.env.ADMIN_PASSWORD;
if (!password || password.length < 8) throw new Error('请设置至少 8 位 ADMIN_PASSWORD');
let users = [];
try { users = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
if (users.length) throw new Error('管理员账号已存在；请在管理后台创建新账号，或手动备份后删除 data/admin-users.json 再初始化');
const salt = crypto.randomBytes(16); const hash = crypto.scryptSync(password, salt, 64);
await fs.writeFile(file, `${JSON.stringify([{ username, role: 'owner', active: true, passwordHash: `scrypt$${salt.toString('base64')}$${hash.toString('base64')}` }], null, 2)}\n`, 'utf8');
console.log(`已创建 owner 账号：${username}`);
