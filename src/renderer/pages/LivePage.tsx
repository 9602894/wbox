// src/renderer/pages/LivePage.tsx
// ★ 2026-11-23 流畅优先版（修正卡顿）：
//   · mpegts.js: enableStashBuffer: true + stashInitialSize: 1MB，用缓冲吸收网络抖动；
//   · liveSync 彻底关闭，只保留 liveBufferLatencyChasing 追帧；
//   · autoCleanupSourceBuffer 开启，防止长播后 SourceBuffer 膨胀引发卡顿；
//   · HLS 同步距离回调到 3 个分片，牺牲少量实时性换取稳定性；
//   · 首帧失败快速重试 + 自动切线路，断流重连上限 15 次。
import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import { client } from '../api/client';
import { ipcInvoke } from '../api/ipc';
import type {
  LiveGroup,
  LiveBean,
  LiveEpgEntry,
  EpgChannelRef,
  LiveSubscription,
} from '../../shared/types';
import { splitLine } from '../../engine/live/LiveUtils';
import {
  sharedHlsPlaylistProbe,
  containerHintForUrl,
  isHlsProbeCandidate,
  resolveDirectPlaybackMode,
  type PlaybackMode,
} from '../live/livePlaybackProbe';

// ---- 频道选择记忆 ----
const LIVE_MEM_KEY = 'winbox-live-mem';
interface LiveMem { liveIdx?: number; groupName?: string; channelName?: string; lineIdx?: number }
function loadLiveMem(): LiveMem {
  try { return JSON.parse(localStorage.getItem(LIVE_MEM_KEY) || '{}') as LiveMem; } catch { return {}; }
}
function saveLiveMem(m: LiveMem): void {
  try { localStorage.setItem(LIVE_MEM_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

type EpgStatus = 'idle' | 'loading' | 'ok' | 'empty' | 'error';

interface LiveSubChangedPayload {
  updated: boolean;
  updatedIds: string[];
  failedIds: string[];
  reason: 'startup' | 'manual' | 'crud';
}

type MediaKind = 'hls' | 'flv' | 'ts' | 'native' | 'unknown';

// 探测结果缓存，同一 URL 5 分钟内不重复探测
const probeCache = new Map<string, { kind: MediaKind; mode: PlaybackMode; reason: string; ts: number }>();
const PROBE_CACHE_TTL = 5 * 60 * 1000;

class StreamDetector {
  static detectByUrl(url: string): MediaKind {
    const lower = url.toLowerCase();
    if (lower.includes('.m3u8')) return 'hls';
    if (lower.includes('.flv')) return 'flv';
    if (/\.ts(\?|#|$)/.test(lower)) return 'ts';
    if (/\.(mp4|mkv|mov|webm|m4v|avi)(\?|#|$)/.test(lower)) return 'native';
    return 'unknown';
  }

  static async detect(url: string): Promise<MediaKind> {
    const byUrl = StreamDetector.detectByUrl(url);
    if (byUrl !== 'unknown') return byUrl;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(url, { method: 'HEAD', mode: 'cors', signal: ctrl.signal });
      clearTimeout(timer);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('mpegurl') || ct.includes('m3u8')) return 'hls';
      if (ct.includes('flv')) return 'flv';
      if (ct.includes('mp2t') || ct.includes('mpegts')) return 'ts';
      if (ct.includes('video/') || ct.includes('audio/')) return 'native';
    } catch {
      /* HEAD 失败或超时，按直播回退 */
    }
    return 'hls';
  }
}

async function detectPlaybackSource(
  url: string,
): Promise<{ kind: MediaKind; mode: PlaybackMode; reason: string }> {
  const cached = probeCache.get(url);
  if (cached && Date.now() - cached.ts < PROBE_CACHE_TTL) {
    return { kind: cached.kind, mode: cached.mode, reason: cached.reason };
  }

  const hint = containerHintForUrl(url);
  const urlKind = StreamDetector.detectByUrl(url);
  let result: { kind: MediaKind; mode: PlaybackMode; reason: string };

  if (hint) {
    result = { kind: urlKind === 'unknown' ? 'native' : urlKind, mode: hint, reason: 'container' };
  } else if (isHlsProbeCandidate(url)) {
    const probe = await sharedHlsPlaylistProbe.probe(url);
    const decision = resolveDirectPlaybackMode({ url, probe });
    result = { kind: 'hls', mode: decision.mode, reason: decision.reason ?? '' };
  } else if (urlKind !== 'unknown') {
    result = { kind: urlKind, mode: 'live', reason: 'default-live' };
  } else {
    const kind = await StreamDetector.detect(url);
    result = { kind, mode: 'live', reason: 'default-live' };
  }

  probeCache.set(url, { ...result, ts: Date.now() });
  return result;
}

// ============================================================
// LiveVideoPlayer —— 流畅优先的播放器内核
// ============================================================
function LiveVideoPlayer({
  url,
  onReconnect,
  onFirstFrameFail,
  onVideoError,
  onModeDetected,
}: {
  url: string;
  onReconnect: () => void;
  onFirstFrameFail: () => void;
  onVideoError: (msg: string) => void;
  onModeDetected?: (mode: PlaybackMode, reason: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<any>(null);
  const mpegtsRef = useRef<any>(null);
  const cbRef = useRef({ onReconnect, onFirstFrameFail, onVideoError, onModeDetected });
  cbRef.current = { onReconnect, onFirstFrameFail, onVideoError, onModeDetected };
  const modeRef = useRef<PlaybackMode>('live');
  const hasPlayedRef = useRef(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !url) return;

    let destroyed = false;
    hasPlayedRef.current = false;

    const destroyHls = () => {
      if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; }
    };
    const destroyMpegts = () => {
      if (mpegtsRef.current) { try { mpegtsRef.current.destroy(); } catch {} mpegtsRef.current = null; }
    };

    const safePlay = () => {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    };

    const handleFailure = (isLive: boolean) => {
      if (!hasPlayedRef.current) {
        cbRef.current.onFirstFrameFail();
      } else if (isLive) {
        cbRef.current.onReconnect();
      }
    };

    const playNative = () => {
      v.src = url;
      v.load();
      safePlay();
    };

    // ---------- HLS: 稳定优先，同步距离回调到 3 个分片 ----------
    const playHls = (sourceUrl: string) => {
      if (!Hls.isSupported()) { playNative(); return; }
      const hls = new Hls({
        enableWorker: true,
        // ★ 不再追求 2 个分片的极限边缘，3 个分片给抖动留余量
        lowLatencyMode: true,
        liveSyncDurationCount: 3,
        backBufferLength: 15,
        maxBufferLength: 15,
        // ★ 1.5Mbps 初始估计，避免首段画质过低
        abrEwmaDefaultEstimate: 1_500_000,
        // ★ 保守 ABR，减少码率反复切换带来的卡顿
        abrBandWidthFactor: 0.8,
        abrBandWidthUpFactor: 0.5,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 6,
        manifestLoadingRetryDelay: 500,
        levelLoadingTimeOut: 10000,
        fragLoadingTimeOut: 20000,
        xhrSetup: (xhr: XMLHttpRequest) => { xhr.withCredentials = false; },
      });
      hlsRef.current = hls;
      hls.loadSource(sourceUrl);
      hls.attachMedia(v);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (destroyed) return;
        safePlay();
      });

      hls.on(Hls.Events.ERROR, (_evt: unknown, data: any) => {
        if (destroyed) return;
        if (!data?.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          cbRef.current.onVideoError('HLS 网络错误，尝试恢复…');
          try { hls.startLoad(); } catch {}
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          cbRef.current.onVideoError('HLS 解码错误，尝试恢复…');
          try { hls.recoverMediaError(); } catch {}
        } else {
          cbRef.current.onVideoError(`HLS 失败：${data.details || data.type}`);
          destroyHls();
          handleFailure(modeRef.current === 'live');
        }
      });
    };

    // ---------- mpegts.js (TS/FLV): 流畅优先，缓冲吸收抖动 ----------
    const playMpegts = async (type: 'flv' | 'mpegts', sourceUrl: string, mode: PlaybackMode) => {
      try {
        // @ts-ignore 动态加载可选依赖
        const mod = await import(/* @vite-ignore */ 'mpegts.js').catch(() => null);
        const mpegts: any = (mod as any)?.default || (mod as any);
        if (!mpegts || typeof mpegts.isSupported !== 'function' || !mpegts.isSupported()) {
          playNative();
          return;
        }
        const player = mpegts.createPlayer(
          {
            type,
            url: sourceUrl,
            isLive: mode === 'live',
            hasAudio: true,
            hasVideo: true,
          },
          {
            enableWorker: true,
            // ★★ 流畅性的基石：开启 IO 暂存缓冲，让网络抖动被缓冲吸收
            enableStashBuffer: true,
            // ★★ 1MB 初始缓冲，官方排障案例确认的稳定值
            stashInitialSize: 1024 * 1024,

            lazyLoad: false,
            deferLoadAfterSourceOpen: false,

            // ★★ liveSync 必须关闭，它与 liveBufferLatencyChasing 冲突，已知会导致冻结/卡死
            liveSync: false,
            // ★★ 追帧只靠 liveBufferLatencyChasing，阈值取官方默认 1.5 / 0.5
            liveBufferLatencyChasing: mode === 'live',
            liveBufferLatencyMaxLatency: 1.5,
            liveBufferLatencyMinRemain: 0.5,
            liveBufferLatencyChasingOnPaused: false,

            // ★ 直播禁用精确 seek，消除跳转卡顿的根源
            accurateSeek: false,

            // ★ 自动清理 SourceBuffer，防止长播后内存膨胀引发卡顿
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 15,
            autoCleanupMinBackwardDuration: 5,
          },
        );
        mpegtsRef.current = player;
        player.attachMediaElement(v);
        player.load();
        try { player.play(); } catch {}
        player.on(mpegts.Events?.ERROR || 'error', (errType: unknown, errDetail: unknown) => {
          cbRef.current.onVideoError(`流错误：${errType}/${errDetail}`);
          handleFailure(mode === 'live');
        });
      } catch {
        playNative();
      }
    };

    (async () => {
      const { kind, mode, reason } = await detectPlaybackSource(url);
      if (destroyed) return;
      modeRef.current = mode;
      cbRef.current.onModeDetected?.(mode, reason);
      if (kind === 'hls') playHls(url);
      else if (kind === 'flv') void playMpegts('flv', url, mode);
      else if (kind === 'ts') void playMpegts('mpegts', url, mode);
      else if (kind === 'native') playNative();
      else playHls(url);
    })();

    const onEnded = () => {
      if (modeRef.current === 'live') handleFailure(true);
    };
    const onErr = () => {
      const err = v.error;
      const code = err?.code;
      const msg = code === 1 ? '用户中止' : code === 2 ? '网络错误' : code === 3 ? '解码错误' : code === 4 ? '源不支持' : `错误(${code ?? '?'})`;
      cbRef.current.onVideoError(msg);
      if (code === 2 || code === 4) handleFailure(modeRef.current === 'live');
    };
    const onPlaying = () => {
      hasPlayedRef.current = true;
      cbRef.current.onVideoError('');
    };

    v.addEventListener('ended', onEnded);
    v.addEventListener('error', onErr);
    v.addEventListener('playing', onPlaying);
    v.addEventListener('play', onPlaying);

    return () => {
      destroyed = true;
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('error', onErr);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('play', onPlaying);
      destroyHls();
      destroyMpegts();
      try { v.removeAttribute('src'); v.load(); } catch {}
    };
  }, [url]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      controls
      style={{ width: '100%', height: '100%', background: '#000', display: 'block' }}
    />
  );
}

// ============================================================
// LivePage
// ============================================================
export default function LivePage() {
  const [lives, setLives] = useState<LiveBean[]>([]);
  const [liveIdx, setLiveIdx] = useState(0);
  const [groups, setGroups] = useState<LiveGroup[]>([]);
  const [groupName, setGroupName] = useState('');
  const [channelName, setChannelName] = useState('');
  const [lineIdx, setLineIdx] = useState(0);
  const [playUrl, setPlayUrl] = useState('');
  const [playbackUrl, setPlaybackUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [epg, setEpg] = useState<Record<string, LiveEpgEntry>>({});
  const [epgStatus, setEpgStatus] = useState<EpgStatus>('idle');
  const epgTimer = useRef<number | null>(null);

  const [subCount, setSubCount] = useState(0);
  const [subEnabled, setSubEnabled] = useState(0);

  const [reconnectKey, setReconnectKey] = useState(0);
  const [reconnectMsg, setReconnectMsg] = useState('');
  const reconnectCountRef = useRef(0);
  const lastReconnectAtRef = useRef(0);
  const firstFrameFailRef = useRef(0);
  const MAX_RECONNECT = 15;

  const [playMode, setPlayMode] = useState<PlaybackMode>('live');
  const [playModeReason, setPlayModeReason] = useState('');

  const playStateRef = useRef({ liveIdx, groupName, channelName, lineIdx, playUrl });
  useEffect(() => {
    playStateRef.current = { liveIdx, groupName, channelName, lineIdx, playUrl };
  }, [liveIdx, groupName, channelName, lineIdx, playUrl]);

  useEffect(() => {
    if (!playUrl) { setPlaybackUrl(''); return; }
    setPlaybackUrl(playUrl);
    reconnectCountRef.current = 0;
    lastReconnectAtRef.current = 0;
    firstFrameFailRef.current = 0;
    setReconnectMsg('');
  }, [playUrl]);

  const doReconnect = useCallback(() => {
    const now = Date.now();
    if (now - lastReconnectAtRef.current < 3000) return;
    lastReconnectAtRef.current = now;
    reconnectCountRef.current += 1;
    const n = reconnectCountRef.current;
    if (n > MAX_RECONNECT) {
      setReconnectMsg(`已连续重连 ${MAX_RECONNECT} 次仍失败，请切换线路`);
      return;
    }
    setReconnectMsg(`断线重连中…（第 ${n} 次）`);
    setReconnectKey((k) => k + 1);
    window.setTimeout(() => {
      setReconnectMsg((cur) => (cur.startsWith('断线重连中') ? '' : cur));
    }, 3000);
  }, []);

  const handleFirstFrameFail = useCallback(() => {
    firstFrameFailRef.current += 1;

    if (firstFrameFailRef.current <= 2) {
      setReconnectMsg(`首帧失败，快速重试…（第 ${firstFrameFailRef.current} 次）`);
      window.setTimeout(() => {
        setReconnectKey((k) => k + 1);
      }, 1000);
      return;
    }

    const cur = playStateRef.current;
    const group = groups.find((g) => g.group === cur.groupName);
    const channel = group?.channels.find((c) => c.name === cur.channelName);
    if (channel && channel.urls.length > 1) {
      const nextLine = (cur.lineIdx + 1) % channel.urls.length;
      const line = splitLine(channel.urls[nextLine], nextLine + 1);
      if (line.url && line.url !== cur.playUrl) {
        firstFrameFailRef.current = 0;
        setReconnectMsg(`当前线路不可用，自动切换到线路 ${nextLine + 1}`);
        setLineIdx(nextLine);
        setPlayUrl(line.url);
        saveLiveMem({ liveIdx: cur.liveIdx, groupName: cur.groupName, channelName: cur.channelName, lineIdx: nextLine });
        return;
      }
    }

    setReconnectMsg('当前频道所有线路均无法播放，请手动选择其他频道');
  }, [groups]);

  const handleVideoError = useCallback((msg: string) => {
    if (msg) setReconnectMsg(msg);
  }, []);

  const reloadLives = useCallback(async () => {
    try {
      const m = await client.liveMeta();
      setLives(m);
      const idx = liveIdx < m.length ? liveIdx : 0;
      setLiveIdx(idx);
      if (m.length && idx !== liveIdx) {
        await loadLiveInternal(idx, m);
      }
    } catch (e) {
      console.warn('[Live] reload lives 失败：', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx]);

  async function loadLiveInternal(index: number, meta?: LiveBean[], forceRefresh = false) {
    const m = meta ?? lives;
    if (!m.length) return;
    setLoading(true);
    setErr('');
    try {
      const r = await client.loadLive(index, { forceRefresh });
      setGroups(r.groups);
      if (r.groups.length) {
        const mem = loadLiveMem();
        const fromMem = mem.liveIdx === index;
        const g = fromMem && mem.groupName ? r.groups.find((x) => x.group === mem.groupName) : undefined;
        const group = g || r.groups[0];
        setGroupName(group.group);
        const ch = fromMem && mem.channelName && group.channels.some((c) => c.name === mem.channelName)
          ? group.channels.find((c) => c.name === mem.channelName)!
          : group.channels[0];
        if (group.channels.length && ch) {
          pickChannelInternal(group, ch.name, fromMem ? (mem.lineIdx || 0) : 0, r.groups, index);
        }
      } else {
        setGroups([]);
        setGroupName('');
        setChannelName('');
        setPlayUrl('');
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function pickLive(index: number, meta?: LiveBean[]) {
    const m = meta ?? lives;
    if (!m.length) return;
    setLiveIdx(index);
    client.cfgSetActiveLive(index).catch(() => undefined);
    void loadLiveInternal(index, m);
  }

  function pickChannelInternal(g: LiveGroup, name: string, li: number, all = groups, idx = liveIdx) {
    setGroupName(g.group);
    setChannelName(name);
    setLineIdx(li);
    saveLiveMem({ liveIdx: idx, groupName: g.group, channelName: name, lineIdx: li });
    const ch = g.channels.find((c) => c.name === name);
    if (ch && ch.urls.length) {
      const line = splitLine(ch.urls[li] || ch.urls[0], li + 1);
      setPlayUrl(line.url);
    }
    if (all !== groups) setGroups(all);
  }
  const pickChannel = pickChannelInternal;

  const loadSubStatus = useCallback(async () => {
    try {
      const list = await ipcInvoke<LiveSubscription[]>('live:subscription:list');
      const arr = Array.isArray(list) ? list : [];
      setSubCount(arr.length);
      setSubEnabled(arr.filter((s) => s.enabled).length);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await client.cfgGet();
        const m = await client.liveMeta();
        if (cancelled) return;
        setLives(m);
        if (m.length) {
          const start = cfg.ui.activeLiveIndex < m.length ? cfg.ui.activeLiveIndex : 0;
          setLiveIdx(start);
          await loadLiveInternal(start, m);
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    void loadSubStatus();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applySubscriptionUpdate = useCallback(async () => {
    const cur = playStateRef.current;
    try {
      const newMeta = await client.liveMeta();
      if (!Array.isArray(newMeta) || newMeta.length === 0) {
        console.warn('[Live] 订阅更新后线路列表为空，保留旧列表与旧地址继续播放');
        return;
      }
      setLives(newMeta);

      const idx = cur.liveIdx < newMeta.length ? cur.liveIdx : 0;
      if (idx !== cur.liveIdx) setLiveIdx(idx);

      const r = await client.loadLive(idx, { forceRefresh: true });
      const newGroups = r.groups;

      if (!cur.groupName || !cur.channelName) {
        setGroups(newGroups);
        return;
      }

      const curGroup = newGroups.find((g) => g.group === cur.groupName);
      const curChannel = curGroup?.channels.find((c) => c.name === cur.channelName);

      if (!curGroup || !curChannel) {
        console.info('[Live] 当前频道已从更新后的源中消失，保留旧列表与旧地址继续播放');
        return;
      }

      setGroups(newGroups);

      const newLine = splitLine(curChannel.urls[cur.lineIdx] || curChannel.urls[0], cur.lineIdx + 1);
      const newUrl = newLine.url || '';
      if (newUrl && newUrl !== cur.playUrl) {
        console.info('[Live] 当前频道地址已更新，使用新地址重播');
        setPlayUrl(newUrl);
      } else {
        console.info('[Live] 当前频道地址未变，仅刷新频道列表');
      }
    } catch (e) {
      console.warn('[Live] 处理订阅更新失败（保留旧播放继续）：', e);
    }
  }, []);

  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:subscriptions-changed', (payload?: LiveSubChangedPayload) => {
      void loadSubStatus();

      if (!payload) {
        void reloadLives();
        return;
      }

      if (!payload.updated) {
        if (payload.reason === 'crud') void reloadLives();
        return;
      }

      void applySubscriptionUpdate();
    });
    return () => { if (typeof off === 'function') off(); };
  }, [loadSubStatus, reloadLives, applySubscriptionUpdate]);

  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:changed', (payload: { index?: number; name?: string; replaced?: boolean }) => {
      console.log('[Live] 收到 live:changed 广播：', payload);
      void (async () => {
        try {
          const m = await client.liveMeta();
          setLives(m);
          const idx = liveIdx < m.length ? liveIdx : 0;
          if (idx !== liveIdx) setLiveIdx(idx);
          if (m.length) {
            await loadLiveInternal(idx, m);
          }
        } catch (e) {
          console.warn('[Live] live:changed 处理后失败：', e);
        }
      })();
    });
    return () => { if (typeof off === 'function') off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx]);

  const curGroup = groups.find((g) => g.group === groupName);
  const curChannel = curGroup?.channels.find((c) => c.name === channelName);
  const curEpg = curChannel ? (epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name]) : undefined;
  const lines = curChannel ? curChannel.urls.map((u, i) => splitLine(u, i + 1)) : [];

  async function refreshEpg(index: number, gs: LiveGroup[], currentChannelName: string) {
    if (!currentChannelName) { setEpg({}); setEpgStatus('empty'); return; }
    const refs: EpgChannelRef[] = [];
    outer: for (const g of gs) {
      for (const c of g.channels) {
        if (c.name !== currentChannelName) continue;
        const r: EpgChannelRef = {
          tvgId: c['tvg-id'],
          tvgName: c['tvg-name'],
          name: c.name,
          epg: c.epg,
        };
        if (r.tvgId || r.tvgName || r.name) refs.push(r);
        break outer;
      }
    }
    if (!refs.length) { setEpg({}); setEpgStatus('empty'); return; }
    setEpgStatus('loading');
    try {
      const r = await client.liveEpg(index, refs);
      setEpg(r.byKey);
      setEpgStatus(Object.keys(r.byKey).length ? 'ok' : 'empty');
    } catch (e) {
      setEpg({});
      setEpgStatus('error');
      console.warn('[EPG] 加载失败：', e);
    }
  }

  useEffect(() => {
    if (!groups.length) return;
    void refreshEpg(liveIdx, groups, channelName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx, groups, channelName]);

  useEffect(() => {
    if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; }
    if (!curChannel) return;
    const e = epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name];
    const at = e?.current?.endTime ?? e?.next?.startTime;
    if (!at) return;
    const delay = Math.max(1000, Math.min(at - Date.now() + 1000, 6 * 3600 * 1000));
    epgTimer.current = window.setTimeout(() => { void refreshEpg(liveIdx, groups, channelName); }, delay);
    return () => {
      if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epg, groupName, channelName, liveIdx]);

  async function openPrograms(channel: { name: string; 'tvg-id'?: string; 'tvg-name'?: string }) {
    const name = (channel.name || '').trim();
    if (!name) return;
    const groupList = groups
      .map((g) => ({
        group: String(g.group || '').trim(),
        channels: g.channels
          .map((c) => ({
            name: String(c.name || '').trim(),
            tvgId: String(c['tvg-id'] || '').trim(),
            tvgName: String(c['tvg-name'] || '').trim(),
          }))
          .filter((c) => !!c.name),
      }))
      .filter((g) => !!g.group && g.channels.length > 0);
    try {
      await ipcInvoke('epg:openWindow', {
        channelName: name,
        tvgId: (channel['tvg-id'] || '').trim(),
        tvgName: (channel['tvg-name'] || '').trim(),
        groups: groupList,
        currentGroup: groupName,
      });
    } catch (e) {
      console.warn('[EPG] 打开节目单窗口失败', e);
    }
  }

  const epgStatusText =
    epgStatus === 'loading' ? '加载中…'
      : epgStatus === 'ok' ? `命中 ${Object.keys(epg).length} 键`
        : epgStatus === 'empty' ? '无节目单'
          : epgStatus === 'error' ? '失败（看日志）'
            : '未触发';

  return (
    <>
      <div className="topbar">
        <select value={liveIdx} onChange={(e) => pickLive(Number(e.target.value))} disabled={loading}>
          {lives.map((l, i) => <option key={i} value={i}>{l.name}</option>)}
        </select>

        <span className="status" style={{ marginLeft: 'auto' }}>
          {loading ? '加载中…' : `${groups.length} 组`}
        </span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          订阅 {subEnabled}/{subCount}
        </span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          EPG：{epgStatusText}
        </span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>
          播放方式：{playMode === 'vod' ? '点播' : '直播'}
          {playModeReason ? `（${playModeReason}）` : ''}
        </span>
      </div>

      <div className="layout-2 content" style={{ padding: 12 }}>
        <div className="left">
          {groups.map((g) => (
            <div
              key={g.group}
              className={`nav-item ${g.group === groupName ? 'active' : ''}`}
              onClick={() => {
                setGroupName(g.group);
                if (g.channels.length) pickChannel(g, g.channels[0].name, 0, groups);
              }}
            >
              {g.group} <span className="muted">({g.channels.length})</span>
            </div>
          ))}
        </div>
        <div className="right">
          {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
          {curGroup ? (
            <>
              <div className="row" style={{ marginBottom: 10, maxHeight: 180, overflow: 'auto' }}>
                {curGroup.channels.map((c) => (
                  <span
                    key={c.name}
                    className={`tag ${c.name === channelName ? 'active' : ''}`}
                    onClick={() => pickChannel(curGroup, c.name, 0, groups)}
                    onDoubleClick={() => openPrograms(c)}
                    title="双击查看完整节目单（独立窗口，可拖到屏幕任意位置）"
                  >
                    {c.name}
                  </span>
                ))}
              </div>
              {lines.length > 1 && (
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="muted">线路：</span>
                  {lines.map((l) => (
                    <span
                      key={l.index}
                      className={`tag ${l.index - 1 === lineIdx ? 'active' : ''}`}
                      onClick={() => {
                        firstFrameFailRef.current = 0;
                        setLineIdx(l.index - 1);
                        setPlayUrl(l.url);
                        saveLiveMem({ liveIdx, groupName, channelName, lineIdx: l.index - 1 });
                      }}
                    >
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
              {curEpg && (curEpg.current || curEpg.next) && curChannel && (
                <div
                  className="live-epg"
                  onClick={() => openPrograms(curChannel)}
                  style={{ cursor: 'pointer' }}
                  title="点击查看完整节目单（独立窗口，可拖到屏幕任意位置）"
                >
                  {curEpg.current && (
                    <span className="live-epg-now">
                      <b>正在播</b> {curEpg.current.start}~{curEpg.current.end} {curEpg.current.title || '（无标题）'}
                    </span>
                  )}
                  {curEpg.next && (
                    <span className="muted">
                      <b>下一档</b> {curEpg.next.start} {curEpg.next.title || '（无标题）'}
                    </span>
                  )}
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>📺</span>
                </div>
              )}

              {playUrl ? (
                <div className="live-player" style={{ position: 'relative' }}>
                  {playbackUrl ? (
                    <LiveVideoPlayer
                      key={`${playbackUrl}__${reconnectKey}`}
                      url={playbackUrl}
                      onReconnect={doReconnect}
                      onFirstFrameFail={handleFirstFrameFail}
                      onVideoError={handleVideoError}
                      onModeDetected={(mode, reason) => {
                        setPlayMode(mode);
                        setPlayModeReason(reason);
                      }}
                    />
                  ) : (
                    <div className="empty" style={{ width: '100%', height: '100%' }}>加载中…</div>
                  )}
                  {reconnectMsg && (
                    <div
                      style={{
                        position: 'absolute', top: 12, left: 12,
                        padding: '6px 12px', borderRadius: 6,
                        background: 'rgba(0,0,0,0.7)', color: '#ffb74d', fontSize: 13,
                        pointerEvents: 'none', zIndex: 20,
                      }}
                    >{reconnectMsg}</div>
                  )}
                </div>
              ) : (
                <div className="empty">无播放地址</div>
              )}
            </>
          ) : (
            <div className="empty">{groups.length ? '选择左侧分组' : '无直播（请先导入含 lives 的配置）'}</div>
          )}
        </div>
      </div>
    </>
  );
}
