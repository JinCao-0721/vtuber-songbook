#!/usr/bin/env python3
"""QQ Music URL and download smoke test.

The script follows the same flow as qqmusic_bridge:
1. Search a song (optional).
2. Ask QQ Music's vkey endpoint for a temporary CDN URL.
3. Download the returned audio file to disk.

Cookie is read from QQMUSIC_COOKIE, --cookie, or --cookie-file.  It is never
written to the output files or printed in full.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


API_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg"
CGI_URL = "https://u.y.qq.com/cgi-bin/musics.fcg"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)


def parse_cookie(raw: str) -> tuple[str, dict[str, str]]:
    """Normalize document.cookie and return (header, key/value mapping)."""
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "\"'":
        raw = raw[1:-1]
    # A copied browser value occasionally has a trailing quote after the last value.
    raw = raw.rstrip("'\" ")
    values: dict[str, str] = {}
    parts: list[str] = []
    for item in raw.split(";"):
        item = item.strip()
        if not item or "=" not in item:
            continue
        key, value = item.split("=", 1)
        key, value = key.strip(), value.strip()
        if key:
            values[key] = value
            parts.append(f"{key}={value}")
    if not parts:
        raise ValueError("Cookie 为空或格式不正确")
    return "; ".join(parts), values


def post_json(url: str, payload: dict[str, Any], cookie: str) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(
        url,
        data=body,
        method="POST",
        headers={
            "User-Agent": USER_AGENT,
            "Referer": "https://y.qq.com/",
            "Origin": "https://y.qq.com",
            "Content-Type": "application/json;charset=UTF-8",
            "Accept": "application/json, text/plain, */*",
            "Cookie": cookie,
        },
    )
    with urlopen(request, timeout=30) as response:
        data = response.read()
    return json.loads(data.decode("utf-8", errors="replace"))


def legacy_search(keyword: str, cookie: str, limit: int = 10) -> list[dict[str, Any]]:
    """Fallback to QQ Music's older search endpoint when the desktop CGI is rejected."""
    query = urlencode(
        {
            "ct": 24,
            "qqmusic_ver": 1298,
            "new_json": 1,
            "remoteplace": "txt.yqq.song",
            "searchid": random.randint(10**13, 10**14 - 1),
            "t": 0,
            "aggr": 1,
            "cr": 1,
            "catZhida": 1,
            "lossless": 1,
            "flag_qc": 0,
            "p": 1,
            "n": limit,
            "w": keyword,
        }
    )
    request = Request(
        f"https://c.y.qq.com/soso/fcgi-bin/client_search_cp?{query}",
        headers={"User-Agent": USER_AGENT, "Referer": "https://y.qq.com/", "Cookie": cookie},
    )
    with urlopen(request, timeout=30) as response:
        text = response.read().decode("utf-8", errors="replace")
    text = re.sub(r"^callback\((.*)\)\s*;?$", r"\1", text, flags=re.S)
    result = json.loads(text)
    return result.get("data", {}).get("song", {}).get("list", []) or []


def search_songs(keyword: str, cookie: str, uin: int, limit: int = 10) -> list[dict[str, Any]]:
    cookie_map = dict(
        item.strip().split("=", 1)
        for item in cookie.split(";")
        if "=" in item
    )
    payload = {
        "comm": {
            "g_tk": 5381,
            "uin": uin,
            "loginUin": uin,
            "format": "json",
            "inCharset": "utf-8",
            "outCharset": "utf-8",
            "notice": 0,
            "platform": "yqq.json",
            "needNewCode": 0,
            "ct": 20,
            "cv": 4747474,
            "authst": cookie_map.get("qqmusic_key", cookie_map.get("qm_keyst", "")),
            "tmeLoginType": int(cookie_map.get("tmeLoginType", "0") or 0),
            "tmeAppID": "qqmusic",
        },
        # The current musicu.fcg search API expects req_1.  The older bridge
        # wrapper used req_0, which now returns code 2000.
        "req_1": {
            "module": "music.search.SearchCgiService",
            "method": "DoSearchForQQMusicDesktop",
            "param": {
                "searchid": str(random.randint(10**13, 10**14 - 1)),
                "query": keyword,
                "page_num": 1,
                "num_per_page": limit,
                "search_type": 0,
            },
        },
    }
    result = post_json(f"{API_URL}?_={int(time.time() * 1000)}&g_tk=5381", payload, cookie)
    response_req = result.get("req_1") or result.get("req_0", {})
    songs = response_req.get("data", {}).get("body", {}).get("song", {}).get("list", [])
    if not isinstance(songs, list) or not songs:
        try:
            fallback = legacy_search(keyword, cookie, limit)
            if fallback:
                return fallback
        except Exception:
            pass
        req = response_req
        data = req.get("data", {})
        raise RuntimeError(
            f"搜索响应没有歌曲：outer_code={result.get('code')}, "
            f"req_code={req.get('code')}, data_keys={list(data) if isinstance(data, dict) else type(data).__name__}"
        )
    return songs


def request_vkey(
    song_mid: str,
    quality: str,
    cookie: str,
    uin: int,
    media_mid: str | None = None,
) -> tuple[str, str]:
    prefixes = {"128": ("C400", "m4a"), "320": ("M800", "mp3"), "flac": ("F000", "flac"), "hires": ("RS01", "flac")}
    prefix, extension = prefixes[quality]

    def call(request_uin: int, with_filename: bool) -> tuple[str, str] | None:
        param: dict[str, Any] = {
            "guid": str(random.randint(10**9, 10**10 - 1)),
            "songmid": [song_mid],
            "songtype": [0],
            "uin": str(request_uin),
            "loginflag": 1,
            "platform": "20",
        }
        if with_filename:
            # QQ's downloadable filename normally uses file.media_mid,
            # which can differ from the song MID (using song MID often gives 404).
            file_id = media_mid or song_mid
            param["filename"] = [f"{prefix}{file_id}.{extension}"]
        payload = {
            "comm": {"format": "json", "uin": request_uin, "ct": 24, "cv": 0},
            "req_1": {"module": "vkey.GetVkeyServer", "method": "CgiGetVkey", "param": param},
        }
        result = post_json(API_URL, payload, cookie)
        req = result.get("req_1", {})
        data = req.get("data", {})
        entries = data.get("midurlinfo") or []
        if req.get("code") != 0 or not entries or not entries[0].get("purl"):
            return None
        purl = entries[0]["purl"]
        server = (data.get("sip") or ["https://ws.stream.qqmusic.qq.com"])[0].rstrip("/")
        actual = Path(purl.split("?", 1)[0]).suffix.lower().lstrip(".") or extension
        return f"{server}/{purl}", actual

    # Try the requested quality explicitly first.  The bridge's current
    # VIP/guest fallback often auto-selects 128K M4A regardless of preference,
    # so keeping the explicit request first makes quality testing observable.
    result = call(uin, True) or call(uin, False) or call(0, True) or call(0, False)
    if not result:
        raise RuntimeError("QQ 音乐没有返回可用 URL（歌曲可能需要 VIP 或 Cookie 已失效）")
    return result


def download(url: str, output: Path, cookie: str, max_bytes: int | None) -> int:
    output.parent.mkdir(parents=True, exist_ok=True)
    request = Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Referer": "https://y.qq.com/",
            "Origin": "https://y.qq.com",
            "Cookie": cookie,
        },
    )
    total = 0
    with urlopen(request, timeout=60) as response, output.open("wb") as target:
        while True:
            chunk = response.read(1024 * 128)
            if not chunk:
                break
            if max_bytes is not None and total + len(chunk) > max_bytes:
                chunk = chunk[: max_bytes - total]
            target.write(chunk)
            total += len(chunk)
            if max_bytes is not None and total >= max_bytes:
                break
    return total


def main() -> int:
    parser = argparse.ArgumentParser(description="QQ Music 搜索、获取直链并下载测试")
    parser.add_argument("--keyword", default="周杰伦", help="搜索关键词（提供 --mid 时忽略）")
    parser.add_argument("--mid", help="QQ 音乐歌曲 MID，例如 003NzWfS1...，可跳过搜索")
    parser.add_argument("--media-mid", help="下载文件 MID；直接使用 --mid 下载高音质时可同时指定")
    parser.add_argument("--index", type=int, default=0, help="选择搜索结果序号，从 0 开始")
    parser.add_argument("--quality", choices=("128", "320", "flac", "hires"), default="128")
    parser.add_argument("--output", default=str(Path(__file__).parent / "downloads"), help="输出目录")
    parser.add_argument("--max-bytes", type=int, help="只下载指定字节数，用于连通性测试")
    parser.add_argument("--cookie", help="document.cookie；也可使用 QQMUSIC_COOKIE")
    parser.add_argument("--cookie-file", help="保存 document.cookie 的本地文件路径")
    args = parser.parse_args()

    raw_cookie = args.cookie
    if not raw_cookie and args.cookie_file:
        raw_cookie = Path(args.cookie_file).read_text(encoding="utf-8")
    raw_cookie = raw_cookie or os.environ.get("QQMUSIC_COOKIE") or ""

    try:
        if raw_cookie.strip():
            cookie, cookie_values = parse_cookie(raw_cookie)
            uin = int(cookie_values.get("uin", "0"))
            if uin <= 0:
                raise ValueError("Cookie 中缺少有效的 uin")
            print(f"Cookie 已读取：uin={uin}，字段数={len(cookie_values)}")
        else:
            cookie, uin = "", 0
            print("未提供 Cookie：使用游客模式 uin=0")

        mid = args.mid
        song: dict[str, Any] | None = None
        if not mid:
            songs = search_songs(args.keyword, cookie, uin)
            if not songs:
                raise RuntimeError("搜索没有返回歌曲")
            print(f"搜索结果（前 {len(songs)} 首）：")
            for index, item in enumerate(songs):
                singers = ", ".join(s.get("name", "") for s in item.get("singer", []))
                file_info = item.get("file") or {}
                album = item.get("album") or {}
                album_name = album.get("name", "") if isinstance(album, dict) else str(album)
                sizes = (
                    f"128={file_info.get('size_128mp3', 0)}B, "
                    f"320={file_info.get('size_320mp3', 0)}B, "
                    f"FLAC={file_info.get('size_flac', 0)}B"
                )
                print(
                    f"  [{index}] {item.get('name') or item.get('title', '')} - {singers}  "
                    f"专辑={album_name}  "
                    f"MID={item.get('mid', '')}  FILEMID={file_info.get('media_mid', '')}  {sizes}"
                )
            if args.index < 0 or args.index >= len(songs):
                raise ValueError(f"--index 超出范围，应为 0 到 {len(songs) - 1}")
            song = songs[args.index]
            mid = song.get("mid")
            if not mid:
                raise RuntimeError("搜索结果缺少歌曲 MID")
            print(f"选择第 {args.index} 首：{song.get('name') or song.get('title', '')}")

        media_mid = args.media_mid
        if song:
            media_mid = (song.get("file") or {}).get("media_mid")
        url, extension = request_vkey(mid, args.quality, cookie, uin, media_mid)
        print(f"获取 URL 成功：format={extension}，url_host={re.match(r'https?://[^/]+', url).group(0)}")
        name = (song or {}).get("name") or mid
        safe_name = re.sub(r'[\\/:*?"<>|\r\n]+', "_", str(name))
        output = Path(args.output) / f"{safe_name}_{mid}.{extension}"
        size = download(url, output, cookie, args.max_bytes)
        print(f"下载成功：{size} bytes -> {output.resolve()}")
        if args.max_bytes:
            print("当前使用了 --max-bytes，仅用于连通性测试；去掉该参数可下载完整文件。")
        return 0
    except (HTTPError, URLError, TimeoutError) as exc:
        print(f"网络请求失败：{exc}", file=sys.stderr)
        return 2
    except (ValueError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"测试失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
