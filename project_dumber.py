#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
project_dumper.py
==================
اسکریپتی برای اسکن کامل یک پروژه (دایرکتوری فعلی به‌صورت پیش‌فرض)،
ساخت یک نمای درختی (structure) از کل پوشه‌ها و فایل‌ها،
و سپس نوشتن محتوای تمام فایل‌های متنی داخل یک فایل txt واحد
(بدون محدودیت حجم/تعداد خط).

استفاده:
    python project_dumper.py
    python project_dumper.py --root /path/to/project --output dump.txt
    python project_dumper.py --root . --output dump.txt --exclude .git venv node_modules

نویسنده: نوشته‌شده توسط Claude به‌عنوان یک اسکریپت آماده‌ی تولید (production-ready)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Iterable, List, Tuple

# ---------------------------------------------------------------------------
# پیکربندی پیش‌فرض
# ---------------------------------------------------------------------------

# پوشه‌هایی که معمولاً جزو "پروژه‌ی واقعی" نیستند و حجم بی‌فایده اضافه می‌کنند.
DEFAULT_EXCLUDED_DIRS = {
    ".git", ".hg", ".svn",
    "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache",
    "venv", ".venv", "env", ".env",
    "node_modules", ".idea", ".vscode",
    "dist", "build", "*.egg-info",
    ".tox", ".cache",
}

# پسوندهایی که تقریباً همیشه باینری هستند (برای تشخیص سریع‌تر، فقط کمکی؛
# تشخیص اصلیِ باینری‌بودن بر اساس محتوای فایل انجام می‌شود).
LIKELY_BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff",
    ".pdf", ".zip", ".tar", ".gz", ".7z", ".rar", ".exe", ".dll", ".so",
    ".o", ".a", ".bin", ".pyc", ".pyo", ".class", ".jar", ".mp3", ".mp4",
    ".mov", ".avi", ".mkv", ".wav", ".flac", ".ttf", ".otf", ".woff",
    ".woff2", ".db", ".sqlite", ".sqlite3",
}

# چند انکودینگ که به ترتیب برای خواندن فایل‌های متنی امتحان می‌شوند.
ENCODINGS_TO_TRY = ("utf-8", "utf-8-sig", "cp1256", "latin-1")


# ---------------------------------------------------------------------------
# توابع کمکی
# ---------------------------------------------------------------------------

def is_binary_file(path: Path, chunk_size: int = 8192) -> bool:
    """
    تشخیص می‌دهد که آیا فایل باینری است یا متنی.
    روش: خواندن چند کیلوبایت اول و بررسی وجود بایت null یا کاراکترهای غیرقابل‌چاپ زیاد.
    """
    try:
        with open(path, "rb") as f:
            chunk = f.read(chunk_size)
    except (OSError, PermissionError):
        return True  # اگر نتوانستیم بخوانیم، به‌عنوان باینری/غیرقابل‌خواندن علامت می‌زنیم

    if not chunk:
        return False  # فایل خالی را متنی در نظر می‌گیریم

    if b"\x00" in chunk:
        return True

    # نسبت بایت‌های غیرقابل‌چاپ را حساب می‌کنیم
    text_chars = bytearray({7, 8, 9, 10, 12, 13, 27} | set(range(0x20, 0x100)) - {0x7f})
    non_text = sum(1 for b in chunk if b not in text_chars)
    return (non_text / len(chunk)) > 0.30


def try_read_text(path: Path) -> Tuple[str, str]:
    """
    تلاش می‌کند فایل را با چند انکودینگ مختلف بخواند.
    خروجی: (محتوا, انکودینگ_استفاده‌شده) یا (پیام‌خطا, "") در صورت شکست کامل.
    """
    last_error: Exception | None = None
    for enc in ENCODINGS_TO_TRY:
        try:
            with open(path, "r", encoding=enc, errors="strict") as f:
                return f.read(), enc
        except (UnicodeDecodeError, UnicodeError) as e:
            last_error = e
            continue
        except (OSError, PermissionError) as e:
            return f"[⚠ خطا در خواندن فایل: {e}]", ""

    # اگر هیچ‌کدام کار نکرد، با replace بخوانیم تا حداقل چیزی از دست نرود
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        return content, "utf-8 (با replace - ممکن است برخی کاراکترها خراب باشند)"
    except (OSError, PermissionError) as e:
        return f"[⚠ خطا در خواندن فایل حتی با replace: {e}]", ""


def should_exclude_dir(dirname: str, excluded: set) -> bool:
    return dirname in excluded


def collect_entries(root: Path, excluded_dirs: set, skip_paths: set) -> List[Path]:
    """
    تمام مسیر پوشه‌ها و فایل‌های زیرمجموعه‌ی root را برمی‌گرداند (به‌جز موارد exclude شده).
    """
    all_paths: List[Path] = []
    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        # فیلتر پوشه‌های excluded (in-place تا os.walk وارد آن‌ها نشود)
        dirnames[:] = sorted(
            d for d in dirnames if not should_exclude_dir(d, excluded_dirs)
        )
        current = Path(dirpath)
        for d in dirnames:
            all_paths.append(current / d)
        for fname in sorted(filenames):
            fpath = current / fname
            if fpath.resolve() in skip_paths:
                continue
            all_paths.append(fpath)
    return all_paths


def build_tree_lines(root: Path, excluded_dirs: set, skip_paths: set) -> List[str]:
    """
    یک نمای درختی شبیه دستور `tree` می‌سازد.
    """
    lines = [f"{root.name}/" if root.name else str(root) + "/"]

    def _walk(dir_path: Path, prefix: str):
        try:
            entries = list(os.scandir(dir_path))
        except (PermissionError, OSError) as e:
            lines.append(f"{prefix}└── [⚠ عدم دسترسی: {e}]")
            return

        dirs = sorted(
            [e for e in entries if e.is_dir(follow_symlinks=False)
             and not should_exclude_dir(e.name, excluded_dirs)],
            key=lambda e: e.name.lower(),
        )
        files = sorted(
            [e for e in entries if not e.is_dir(follow_symlinks=False)
             and Path(e.path).resolve() not in skip_paths],
            key=lambda e: e.name.lower(),
        )
        items = dirs + files
        count = len(items)

        for idx, entry in enumerate(items):
            is_last = idx == count - 1
            connector = "└── " if is_last else "├── "
            name = entry.name + ("/" if entry.is_dir(follow_symlinks=False) else "")
            lines.append(f"{prefix}{connector}{name}")
            if entry.is_dir(follow_symlinks=False):
                extension = "    " if is_last else "│   "
                _walk(Path(entry.path), prefix + extension)

    _walk(root, "")
    return lines


def human_size(num_bytes: int) -> str:
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024:
            return f"{size:.1f}{unit}"
        size /= 1024
    return f"{size:.1f}PB"


# ---------------------------------------------------------------------------
# منطق اصلی
# ---------------------------------------------------------------------------

def dump_project(root_dir: str, output_file: str, extra_excluded_dirs: Iterable[str]) -> None:
    root = Path(root_dir).resolve()
    if not root.exists() or not root.is_dir():
        print(f"❌ خطا: مسیر '{root}' وجود ندارد یا یک دایرکتوری نیست.")
        sys.exit(1)

    excluded_dirs = set(DEFAULT_EXCLUDED_DIRS) | set(extra_excluded_dirs)

    output_path = Path(output_file).resolve()
    script_path = Path(__file__).resolve() if "__file__" in globals() else None

    # این دو مسیر (فایل خروجی و خودِ اسکریپت) نباید در دامپ ظاهر شوند
    skip_paths = {output_path}
    if script_path is not None:
        skip_paths.add(script_path)

    print(f"📂 اسکن دایرکتوری: {root}")

    all_files = [
        p for p in collect_entries(root, excluded_dirs, skip_paths) if p.is_file()
    ]

    print(f"🔍 تعداد فایل‌های یافت‌شده: {len(all_files)}")
    print("🌳 در حال ساخت ساختار درختی پروژه...")
    tree_lines = build_tree_lines(root, excluded_dirs, skip_paths)

    print(f"✍️  در حال نوشتن خروجی در: {output_path}")

    text_file_count = 0
    binary_file_count = 0
    error_file_count = 0
    total_chars = 0

    with open(output_path, "w", encoding="utf-8", errors="replace") as out:
        # ---------- بخش ۱: ساختار کلی پروژه ----------
        out.write("=" * 80 + "\n")
        out.write("ساختار کامل پروژه (Project Structure)\n")
        out.write("=" * 80 + "\n\n")
        out.write("\n".join(tree_lines))
        out.write("\n\n")

        # ---------- بخش ۲: محتوای فایل‌ها ----------
        out.write("=" * 80 + "\n")
        out.write("محتوای فایل‌ها (File Contents)\n")
        out.write("=" * 80 + "\n\n")

        for fpath in all_files:
            rel_path = fpath.relative_to(root).as_posix()
            try:
                size = fpath.stat().st_size
            except OSError:
                size = 0

            if is_binary_file(fpath):
                binary_file_count += 1
                out.write(f"{rel_path}:\n")
                out.write(f"[⏭ فایل باینری - محتوا نمایش داده نشد | حجم: {human_size(size)}]\n")
                out.write("\n" + ("-" * 80) + "\n\n")
                continue

            content, enc = try_read_text(fpath)
            if enc == "":
                error_file_count += 1
            else:
                text_file_count += 1
                total_chars += len(content)

            out.write(f"{rel_path}:\n")
            out.write(content)
            if not content.endswith("\n"):
                out.write("\n")
            out.write("\n" + ("-" * 80) + "\n\n")

    print("✅ اتمام موفقیت‌آمیز.")
    print(f"   - فایل‌های متنی خوانده‌شده: {text_file_count}")
    print(f"   - فایل‌های باینری (skip شده): {binary_file_count}")
    print(f"   - فایل‌های با خطای خواندن: {error_file_count}")
    print(f"   - مجموع کاراکترهای نوشته‌شده: {total_chars:,}")
    print(f"   - خروجی نهایی: {output_path}")


def parse_args(argv: List[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="اسکن کامل یک پروژه و دامپ ساختار + محتوای تمام فایل‌ها در یک فایل txt."
    )
    parser.add_argument(
        "--root", "-r", default=".",
        help="مسیر ریشه‌ی پروژه برای اسکن (پیش‌فرض: دایرکتوری فعلی)",
    )
    parser.add_argument(
        "--output", "-o", default="project_dump.txt",
        help="نام/مسیر فایل خروجی txt (پیش‌فرض: project_dump.txt)",
    )
    parser.add_argument(
        "--exclude", "-e", nargs="*", default=[],
        help="نام پوشه‌های اضافی که باید نادیده گرفته شوند (علاوه بر لیست پیش‌فرض)",
    )
    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    dump_project(args.root, args.output, args.exclude)


if __name__ == "__main__":
    main()