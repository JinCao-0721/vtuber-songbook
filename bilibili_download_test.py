#!/usr/bin/env python3
"""Download a Bilibili video's audio and optionally cut it to an MP3 clip.

This is a small, repeatable ingestion tool for the site's cover audio files.
It delegates extraction to yt-dlp and ffmpeg, and never prints cookie values.
"""

from __future__ import annotations

import argparse
import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="下载 B 站视频音频并截取为 MP3")
    parser.add_argument("--url", required=True, help="Bilibili 视频 URL（支持 BV 链接）")
    parser.add_argument("--start", help="片段开始时间，例如 00:01:12；不填表示从开头")
    parser.add_argument("--end", help="片段结束时间，例如 00:05:03；不填表示到结尾")
    parser.add_argument("--output", default="downloads/covers", help="输出目录")
    parser.add_argument("--audio-quality", default="192", choices=("128", "192", "320"))
    parser.add_argument("--cookie-file", help="yt-dlp cookies.txt 文件（可选）")
    parser.add_argument("--proxy", help="代理地址（可选，例如 http://127.0.0.1:7890）")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if not args.start and not args.end:
        section = None
    else:
        section = f"*{args.start or '0'}-{args.end or 'inf'}"

    if importlib.util.find_spec("yt_dlp") is None:
        raise RuntimeError("未安装 yt-dlp，请执行：python -m pip install -U yt-dlp")
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("找不到 ffmpeg，请先安装并加入 PATH")

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(output_dir / "%(title).200s_%(id)s.%(ext)s")
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--newline",
        "--no-playlist",
        "--print",
        "after_move:filepath",
        "-f",
        "bestaudio/best",
        "-x",
        "--audio-format",
        "mp3",
        "--audio-quality",
        f"{args.audio_quality}K",
        "-o",
        output_template,
    ]
    if section:
        command += ["--download-sections", section, "--force-keyframes-at-cuts"]
    if args.cookie_file:
        command += ["--cookies", args.cookie_file]
    if args.proxy:
        command += ["--proxy", args.proxy]
    command.append(args.url)

    print("开始下载 B 站音频（Cookie 内容不会打印）…")
    result = subprocess.run(command, check=False)
    if result.returncode:
        print("下载失败。请检查 URL、Cookie、网络或视频是否允许下载。", file=sys.stderr)
        return result.returncode
    print(f"完成，MP3 输出目录：{output_dir.resolve()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(f"测试失败：{exc}", file=sys.stderr)
        raise SystemExit(1)
