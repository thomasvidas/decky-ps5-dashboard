import asyncio
from base64 import b64encode
import json
import os
import stat
from pathlib import Path
from shutil import copyfileobj
from tempfile import NamedTemporaryFile
from threading import Lock

import decky

from hltb_client import HltbClient

SETTINGS_FILE = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")
HLTB_CACHE_FILE = os.path.join(decky.DECKY_PLUGIN_RUNTIME_DIR, "hltb_cache.json")
WALLPAPER_DIR = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "wallpapers")
WALLPAPER_FORMATS = (("jpg", "jpeg"), ("jpeg", "jpeg"), ("png", "png"), ("webp", "webp"))
MAX_WALLPAPER_BYTES = 4 * 1024 * 1024
MENU_MUSIC_DIR = Path(decky.DECKY_PLUGIN_RUNTIME_DIR) / "menu-music"
MENU_MUSIC_EXTENSIONS = (".mp3", ".ogg", ".wav", ".flac")
menu_music_lock = Lock()


def valid_appid(appid: int) -> bool:
    return type(appid) is int and -(2**31) <= appid < 2**32


def get_menu_music(appid: int) -> str | None:
    if not valid_appid(appid):
        return None
    with menu_music_lock:
        for extension in MENU_MUSIC_EXTENSIONS:
            track = MENU_MUSIC_DIR / f"{appid}{extension}"
            try:
                info = track.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            if stat.S_ISREG(info.st_mode) and info.st_size:
                return f"{track.name}?v={info.st_mtime_ns}"
    return None


def save_menu_music(appid: int, path: str) -> None:
    source = Path(path)
    extension = source.suffix.lower()
    if not valid_appid(appid) or extension not in MENU_MUSIC_EXTENSIONS:
        raise ValueError("Invalid menu music file or app ID")

    MENU_MUSIC_DIR.mkdir(parents=True, exist_ok=True)
    target = MENU_MUSIC_DIR / f"{appid}{extension}"
    staged = None
    try:
        fd = os.open(source, os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as audio:
            info = os.fstat(audio.fileno())
            if not stat.S_ISREG(info.st_mode) or not info.st_size:
                raise ValueError("Menu music must be a nonempty file")
            with NamedTemporaryFile(dir=MENU_MUSIC_DIR, delete=False) as temp:
                staged = Path(temp.name)
                copyfileobj(audio, temp)
                if not temp.tell():
                    raise ValueError("Menu music file is empty")
        with menu_music_lock:
            staged.replace(target)
            for other in MENU_MUSIC_EXTENSIONS:
                if other != extension:
                    (MENU_MUSIC_DIR / f"{appid}{other}").unlink(missing_ok=True)
    finally:
        if staged is not None:
            staged.unlink(missing_ok=True)


def read_wallpaper(appid: int) -> str | None:
    """Read a per-game image from the wallpaper folder without following symlinks."""
    if not valid_appid(appid):
        return None
    try:
        folder = os.open(WALLPAPER_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        return None
    try:
        for suffix, subtype in WALLPAPER_FORMATS:
            try:
                fd = os.open(f"{appid}.{suffix}", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
                with os.fdopen(fd, "rb") as image:
                    info = os.fstat(image.fileno())
                    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_WALLPAPER_BYTES:
                        continue
                    data = image.read(MAX_WALLPAPER_BYTES + 1)
            except OSError:
                continue
            if 0 < len(data) <= MAX_WALLPAPER_BYTES:
                return f"data:image/{subtype};base64,{b64encode(data).decode('ascii')}"
    finally:
        os.close(folder)
    return None


class Plugin:
    hltb: HltbClient | None = None

    async def menu_music_start_path(self) -> str:
        return decky.DECKY_USER_HOME

    async def get_menu_music(self, appid: int) -> str | None:
        return await asyncio.to_thread(get_menu_music, appid)

    async def save_menu_music(self, appid: int, path: str) -> None:
        await asyncio.to_thread(save_menu_music, appid, path)

    async def get_wallpaper(self, appid: int) -> str | None:
        return await asyncio.to_thread(read_wallpaper, appid)

    async def hltb_times(self, appid: int, name: str) -> dict | None:
        """HowLongToBeat times (in seconds) for a game, or None if it isn't found."""
        if self.hltb is None:
            self.hltb = HltbClient(HLTB_CACHE_FILE)
        # The lookup does blocking HTTP; keep it off the loader's event loop.
        return await asyncio.get_running_loop().run_in_executor(None, self.hltb.get, int(appid), str(name))

    async def get_settings(self) -> dict:
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return {}
        except Exception as e:
            decky.logger.error(f"Could not read settings: {e}")
            return {}

    async def set_settings(self, settings: dict) -> bool:
        try:
            os.makedirs(decky.DECKY_PLUGIN_SETTINGS_DIR, exist_ok=True)
            tmp = SETTINGS_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(settings, f, indent=2)
            os.replace(tmp, SETTINGS_FILE)
            return True
        except Exception as e:
            decky.logger.error(f"Could not save settings: {e}")
            return False

    async def _main(self):
        decky.logger.info("PS5 Dashboard loaded")

    async def _unload(self):
        decky.logger.info("PS5 Dashboard unloaded")
