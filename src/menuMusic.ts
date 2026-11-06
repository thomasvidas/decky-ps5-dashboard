import { callable, FileSelectionType, openFilePicker, toaster } from "@decky/api";
import { Router } from "@decky/ui";
import { RefObject, useEffect } from "react";

import { t } from "./i18n";

const getStartPath = callable<[], string>("menu_music_start_path");
const saveTrack = callable<[appid: number, path: string]>("save_menu_music");
const getTrack = callable<[appid: number], string | null>("get_menu_music");
const listTracks = callable<[], number[]>("list_menu_music");
const removeTrack = callable<[appid: number]>("remove_menu_music");
const AUDIO_EXTENSIONS = ["mp3", "ogg", "wav", "flac"];
const PREVIEW_DELAY_MS = 120;
const FADE_MS = 220;
const PREVIEW_VOLUME = 0.35;

// Steam builds its menu items synchronously, so load track assignments before opening a menu.
const gamesWithMusic = new Set<number>();
let trackList: Promise<void> | undefined;
let lastTrackChange = Promise.resolve();

export function loadMenuMusicIndex() {
  return trackList ??= listTracks().then((appids) => {
    for (const appid of appids) gamesWithMusic.add(appid);
  }).catch((error) => {
    trackList = undefined;
    console.warn("[ps5-dashboard] menu music list failed", error);
  });
}

export const hasMenuMusic = (appid: number) => gamesWithMusic.has(appid);

interface Track {
  audio: HTMLAudioElement;
  timer?: number;
}

function dispose(track: Track) {
  window.clearInterval(track.timer);
  track.audio.pause();
  track.audio.removeAttribute("src");
  track.audio.load();
}

function fade(track: Track, volume: number, done?: () => void) {
  window.clearInterval(track.timer);
  const from = track.audio.volume;
  if (from === volume) {
    done?.();
    return;
  }
  const start = performance.now();
  track.timer = window.setInterval(() => {
    const progress = Math.min(1, (performance.now() - start) / FADE_MS);
    track.audio.volume = from + (volume - from) * progress;
    if (progress === 1) {
      window.clearInterval(track.timer);
      done?.();
    }
  }, 20);
}

class MenuMusicPreview {
  private appid?: number;
  private requestedApp?: number;
  private request = 0;
  private previewTimer?: number;
  private launchTimer?: number;
  private active?: Track;
  private outgoing?: Track;
  private launches = new Set<number>();
  private running = new Set<number>();

  constructor(private doc: Document) {}

  watch() {
    const steam = window.SteamClient;
    const start = steam?.Apps?.RegisterForGameActionStart?.((id, _gameId, action) => {
      if (action !== "LaunchApp") return;
      this.launches.add(id);
      this.refresh();
    });
    const end = steam?.Apps?.RegisterForGameActionEnd?.((id) => {
      if (this.launches.delete(id)) this.beginLaunch(600);
    });
    const lifetime = steam?.GameSessions?.RegisterForAppLifetimeNotifications?.((app) => {
      if (app.bRunning) {
        this.running.add(app.nInstanceID);
        this.refresh();
      } else {
        this.running.delete(app.nInstanceID);
        // Give Steam's router time to clear the running app before checking it again.
        this.beginLaunch(300);
      }
    });
    const visibility = () => this.refresh();
    const retry = () => {
      if (this.active?.audio.paused) this.play(this.active);
    };
    this.doc.addEventListener("visibilitychange", visibility);
    this.doc.addEventListener("pointerdown", retry);
    this.doc.addEventListener("keydown", retry);
    return () => {
      start?.unregister();
      end?.unregister();
      lifetime?.unregister();
      this.doc.removeEventListener("visibilitychange", visibility);
      this.doc.removeEventListener("pointerdown", retry);
      this.doc.removeEventListener("keydown", retry);
      this.close();
    };
  }

  select(appid?: number) {
    this.appid = appid;
    this.refresh();
  }

  reload(appid: number) {
    if (this.appid === appid) this.refresh(true);
  }

  beginLaunch(delay = 3000) {
    window.clearTimeout(this.launchTimer);
    this.launchTimer = window.setTimeout(() => {
      this.launchTimer = undefined;
      this.refresh();
    }, delay);
    this.refresh();
  }

  private close() {
    ++this.request;
    window.clearTimeout(this.previewTimer);
    window.clearTimeout(this.launchTimer);
    this.fadeOut();
  }

  private fadeOut() {
    if (!this.active) return;
    if (this.outgoing) dispose(this.outgoing);
    const track = this.outgoing = this.active;
    this.active = undefined;
    fade(track, 0, () => {
      dispose(track);
      this.outgoing = undefined;
    });
  }

  private refresh(force = false) {
    const hidden = this.doc.visibilityState === "hidden";
    const blocked = hidden || this.launchTimer !== undefined || this.launches.size || this.running.size || Router?.MainRunningAppID;
    const appid = blocked ? undefined : this.appid;
    if (!force && appid === this.requestedApp) return;
    this.requestedApp = appid;
    const request = ++this.request;
    window.clearTimeout(this.previewTimer);
    this.fadeOut();
    if (appid !== undefined) {
      this.previewTimer = window.setTimeout(() => void this.load(appid, request), PREVIEW_DELAY_MS);
    }
  }

  private async load(appid: number, request: number) {
    try {
      const file = await getTrack(appid);
      if (!file || request !== this.request) return;
      const audio = this.doc.createElement("audio");
      audio.src = new URL(`../data/menu-music/${file}`, import.meta.url).href;
      audio.loop = true;
      audio.volume = 0;
      this.active = { audio };
      this.play(this.active);
    } catch (error) {
      console.warn("[ps5-dashboard] menu music lookup failed", error);
    }
  }

  private play(track: Track) {
    void track.audio.play().then(() => {
      if (this.active === track) fade(track, PREVIEW_VOLUME);
    }).catch((error) => {
      if (this.active !== track || error?.name === "NotAllowedError") return;
      dispose(track);
      this.active = undefined;
      console.warn("[ps5-dashboard] menu music playback failed", error);
    });
  }
}

let homePreview: MenuMusicPreview | undefined;

export function useMenuMusic(appid: number | undefined, home: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const preview = new MenuMusicPreview(home.current?.ownerDocument ?? document);
    const unwatch = preview.watch();
    homePreview = preview;
    return () => {
      if (homePreview === preview) homePreview = undefined;
      unwatch();
    };
  }, [home]);
  useEffect(() => homePreview?.select(appid), [appid]);
}

export function fadeMenuMusicForLaunch() {
  homePreview?.beginLaunch();
}

function changeTrack(appid: number, assigned: boolean, write: () => Promise<void>) {
  const change = lastTrackChange.then(async () => {
    await write();
    await loadMenuMusicIndex();
    if (assigned) gamesWithMusic.add(appid);
    else gamesWithMusic.delete(appid);
    homePreview?.reload(appid);
  });
  lastTrackChange = change.catch(() => {});
  return change;
}

export async function changeMenuMusic(appid: number, name: string) {
  try {
    const startPath = await getStartPath();
    const file = await openFilePicker(FileSelectionType.FILE, startPath, true, true, undefined, AUDIO_EXTENSIONS, false, false)
      .catch((error) => {
        if (typeof error === "string" && error.toLowerCase() === "user canceled") return null;
        throw error;
      });
    if (!file) return;
    await changeTrack(appid, true, () => saveTrack(appid, file.path));
    toaster.toast({ title: t.menuMusicSaved, body: name });
  } catch (error) {
    console.warn("[ps5-dashboard] menu music import failed", error);
    toaster.toast({ title: t.menuMusicFailed, body: name });
  }
}

export async function removeMenuMusic(appid: number, name: string) {
  try {
    await changeTrack(appid, false, () => removeTrack(appid));
    toaster.toast({ title: t.menuMusicRemoved, body: name });
  } catch (error) {
    console.warn("[ps5-dashboard] menu music removal failed", error);
    toaster.toast({ title: t.menuMusicRemoveFailed, body: name });
  }
}
