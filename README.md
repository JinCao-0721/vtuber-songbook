# 歌单音频获取工具

项目包含两个音频获取测试脚本：QQ 音乐原唱下载，以及 Bilibili 翻唱音频下载/截取。

## QQ 音乐原唱

脚本会搜索歌曲、请求 QQ 音乐 vkey 直链，并下载到 `downloads/`。

PowerShell 用法：

```powershell
$env:QQMUSIC_COOKIE = Get-Content .\qqmusic_cookie.txt -Raw
python .\qqmusic_download_test.py --keyword "周杰伦" --quality 128 --max-bytes 4096
```

去掉 `--max-bytes` 会下载完整文件。也可以直接指定歌曲 MID，跳过搜索：

```powershell
python .\qqmusic_download_test.py --mid "歌曲MID" --quality 320
```

如果直接指定 MID 下载 320K/FLAC，建议同时指定搜索结果中显示的 `FILEMID`：

```powershell
python .\qqmusic_download_test.py --mid "歌曲MID" --media-mid "文件MID" --quality flac
```

搜索时列表会显示专辑、时长和各音质文件大小。用 `--index` 选择指定版本（从 0 开始）：

```powershell
python .\qqmusic_download_test.py --keyword "晴天 周杰伦" --index 2 --quality 320
```

Cookie 也支持 `--cookie-file` 或 `--cookie` 参数。脚本不会打印或保存完整 Cookie。

不提供 Cookie 时会自动使用游客模式（`uin=0`），部分歌曲或高音质可能不可用：

```powershell
Remove-Item Env:QQMUSIC_COOKIE -ErrorAction SilentlyContinue
python .\qqmusic_download_test.py --keyword "周杰伦" --quality 128 --max-bytes 4096
```

## Bilibili 翻唱

先安装依赖，并确保 `ffmpeg` 在 PATH 中：

```powershell
python -m pip install -r requirements.txt
```

下载完整视频音频：

```powershell
python .\bilibili_download_test.py --url "https://www.bilibili.com/video/BV..." --output public/media/covers
```

只截取指定歌切并转成 MP3：

```powershell
python .\bilibili_download_test.py `
  --url "https://www.bilibili.com/video/BV..." `
  --start 00:01:12 --end 00:05:03 `
  --audio-quality 192 `
  --output public/media/covers
```

如果视频需要登录，把浏览器导出的 `cookies.txt` 传给 `--cookie-file`。脚本不会打印 Cookie 内容。

## 管理后台

管理后台使用账号体系和 JSON 文件保存数据，前端构建时会读取同一份歌曲数据。首次初始化 owner 账号：

```powershell
$env:ADMIN_USERNAME = "admin"
$env:ADMIN_PASSWORD = "至少 8 位强密码"
npm run admin:init
```

修改现有 owner 账号：

```powershell
$env:OLD_ADMIN_USERNAME = "admin"
$env:ADMIN_USERNAME = "新账号"
$env:ADMIN_PASSWORD = "新密码"
npm run admin:change
```

启动后台：

```powershell
$env:SITE_ID = "ii7"
npm run admin
```

打开 `http://127.0.0.1:4322/admin`，登录后可以新增、编辑、删除歌曲。导入 QQ 歌单并填写 BV 号后，后台会自动调用现有 Bilibili 下载脚本，把翻唱 MP3 放入 `public/media/covers/` 并绑定到歌曲；原唱音频仍由 QQ 音乐脚本下载后整理到 `public/media/original/`。数据保存于 `data/songs.json`。修改数据后重新执行 `npm run build`，静态浏览页即可更新。

管理员角色分为 `owner`（管理账号和歌曲）、`editor`（管理歌曲）和 `viewer`（只读）。owner 登录后台后可以创建不同角色的账号。账号密码只保存为 scrypt 哈希，`data/admin-users.json` 已加入忽略列表。每个 VUP 使用独立的 `SITE_ID` 和域名。构建前设置同名的 `PUBLIC_SITE_ID`，浏览页只会显示该 VUP 的歌曲；管理后台的 `SITE_ID` 也只允许管理该 VUP 的数据。后台 API 默认只监听 `127.0.0.1`；如果通过反向代理提供远程访问，请在代理和防火墙层继续限制管理入口。

例如部署另一个 VUP：

```powershell
$env:PUBLIC_SITE_ID = "vup-b"
$env:PUBLIC_SITE_URL = "https://vup-b.example.com"
npm run build

$env:SITE_ID = "vup-b"
$env:ADMIN_PASSWORD = "另一组强密码"
npm run admin
```
