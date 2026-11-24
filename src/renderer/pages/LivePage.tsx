// src/renderer/pages/LivePage.tsx
// 直播页：频道/分组/EPG/订阅/记忆逻辑保持不变；直播播放打开独立播放器窗口（mpv 内核）。
//
// ⚠️ 架构说明（基于仓库真实代码，勿改回主窗口内嵌 mpv）：
//   - MpvController 通过 `--wid` 把 mpv 嵌入**整个 BrowserWindow**（hwndOf / MpvController.start）。
//   - 主窗口（src/main/index.ts createWindow）不透明（backgroundColor + mica），无法嵌入 mpv。
//   - 只有 PlayerWindow（transparent: true）能嵌入 mpv；VideoPlayer.allowMpv 注释明确
//     「仅独立播放器窗口传 true，主窗口里的直播保持纯 HTML5」。
//   - 因此 LivePage 改为打开独立播放器窗口播放（与点播一致），mpv 在该窗口内渲染。
//
// ★ 2026-11-24（用户报「TS 直播缓存太久」）：真正解决 TS 慢的参数在
//   src/main/player/MpvController.ts 的 startInternal 里（probesize / analyzeduration），
//   不在本文件。LivePage 只负责透传 URL 类型（meta.streamType），方便主进程按流类型差异化。
import { useEffect, useRef, useState, useCallback } from 'react';
import { client } from '../api/client';
import { ipcInvoke } from '../api/ipc';
import { IPC } from '../../shared/ipc-channels';
import type {
  LiveGroup,
  LiveBean,
  LiveEpgEntry,
  EpgChannelRef,
  LiveSubscription,
} from '../../shared/types';
import { splitLine } from '../../engine/live/LiveUtils';

const LIVE_MEM_KEY = 'winbox-live-mem';
interface LiveMem { liveIdx?: number; groupName?: string; channelName?: string; lineIdx?: number }
function loadLiveMem(): LiveMem {
  try { return JSON.parse(localStorage.getItem(LIVE_MEM_KEY) || '{}') as LiveMem; } catch { return {}; }
}
function saveLiveMem(m: LiveMem): void {
  try { localStorage.setItem(LIVE_MEM_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

/** 按 URL 后缀判断直播流类型（供主进程差异化 mpv 参数；纯辅助，不阻塞播放） */
function detectStreamType(url: string): 'hls' | 'ts' | 'other' {
  const path = url.toLowerCase().split('?')[0].split('#')[0];
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.ts')) return 'ts';
  return 'other';
}

type EpgStatus = 'idle' | 'loading' | 'ok' | 'empty' | 'error';
interface LiveSubChangedPayload {
  updated: boolean; updatedIds: string[]; failedIds: string[];
  reason: 'startup' | 'manual' | 'crud';
}

export default function LivePage() {
  const [lives, setLives] = useState<LiveBean[]>([]);
  const [liveIdx, setLiveIdx] = useState(0);
  const [groups, setGroups] = useState<LiveGroup[]>([]);
  const [groupName, setGroupName] = useState('');
  const [channelName, setChannelName] = useState('');
  const [lineIdx, setLineIdx] = useState(0);
  const [playUrl, setPlayUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [epg, setEpg] = useState<Record<string, LiveEpgEntry>>({});
  const [epgStatus, setEpgStatus] = useState<EpgStatus>('idle');
  const epgTimer = useRef<number | null>(null);
  const [subCount, setSubCount] = useState(0);
  const [subEnabled, setSubEnabled] = useState(0);

  const playStateRef = useRef({ liveIdx, groupName, channelName, lineIdx, playUrl });
  useEffect(() => { playStateRef.current = { liveIdx, groupName, channelName, lineIdx, playUrl }; }, [liveIdx, groupName, channelName, lineIdx, playUrl]);

  /** 打开独立播放器窗口播放直播（mpv 内核）。
   *  PlayerInit 结构见 src/main/player/PlayerWindow.ts；lastUrl 非空时 PlayerPage 直接用它播放，
   *  不走 client.play 解析。
   *  ★ 透传 streamType：主进程 MpvController 可据此对 TS / HLS 用不同探测参数
   *    （当前默认统一激进参数已能解决 TS 慢，streamType 是可选扩展）。 */
  const openLivePlayer = useCallback((url: string, name: string) => {
    if (!url) return;
    const streamType = detectStreamType(url);
    const init = {
      key: '',
      flag: '',
      episodes: [{ name, url }],
      epIndex: 0,
      title: name,
      subtitleTitle: name,
      lastUrl: url,
      lastName: name,
      meta: { sourceName: '直播', streamType },
    };
    void ipcInvoke(IPC.PLAYER_OPEN, init).catch((e) => {
      setErr(`打开播放器窗口失败：${(e as Error).message}`);
    });
  }, []);

  const reloadLives = useCallback(async () => {
    try {
      const m = await client.liveMeta(); setLives(m);
      const idx = liveIdx < m.length ? liveIdx : 0;
      setLiveIdx(idx);
      if (m.length && idx !== liveIdx) await loadLiveInternal(idx, m);
    } catch (e) { console.warn('[Live] reload lives 失败：', e); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveIdx]);

  async function loadLiveInternal(index: number, meta?: LiveBean[], forceRefresh = false) {
    const m = meta ?? lives;
    if (!m.length) return;
    setLoading(true); setErr('');
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
          ? group.channels.find((c) => c.name === mem.channelName)! : group.channels[0];
        if (group.channels.length && ch) pickChannelInternal(group, ch.name, fromMem ? (mem.lineIdx || 0) : 0, r.groups, index);
      } else { setGroups([]); setGroupName(''); setChannelName(''); setPlayUrl(''); }
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }

  function pickLive(index: number, meta?: LiveBean[]) {
    const m = meta ?? lives;
    if (!m.length) return;
    setLiveIdx(index);
    client.cfgSetActiveLive(index).catch(() => undefined);
    void loadLiveInternal(index, m);
  }

  function pickChannelInternal(g: LiveGroup, name: string, li: number, all = groups, idx = liveIdx) {
    setGroupName(g.group); setChannelName(name); setLineIdx(li);
    saveLiveMem({ liveIdx: idx, groupName: g.group, channelName: name, lineIdx: li });
    const ch = g.channels.find((c) => c.name === name);
    if (ch && ch.urls.length) { const line = splitLine(ch.urls[li] || ch.urls[0], li + 1); setPlayUrl(line.url); }
    if (all !== groups) setGroups(all);
  }

  /** 用户主动选台：更新状态 + 打开播放器窗口播放（初始化/订阅刷新走 pickChannelInternal，不弹窗） */
  function pickChannel(g: LiveGroup, name: string, li: number, all = groups, idx = liveIdx) {
    pickChannelInternal(g, name, li, all, idx);
    const ch = g.channels.find((c) => c.name === name);
    if (ch && ch.urls.length) {
      const line = splitLine(ch.urls[li] || ch.urls[0], li + 1);
      openLivePlayer(line.url, name);
    }
  }

  const loadSubStatus = useCallback(async () => {
    try {
      const list = await ipcInvoke<LiveSubscription[]>('live:subscription:list');
      const arr = Array.isArray(list) ? list : [];
      setSubCount(arr.length); setSubEnabled(arr.filter((s) => s.enabled).length);
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
          setLiveIdx(start); await loadLiveInternal(start, m);
        }
      } catch (e) { if (!cancelled) setErr((e as Error).message); }
    })();
    void loadSubStatus();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applySubscriptionUpdate = useCallback(async () => {
    const cur = playStateRef.current;
    try {
      const newMeta = await client.liveMeta();
      if (!Array.isArray(newMeta) || newMeta.length === 0) return;
      setLives(newMeta);
      const idx = cur.liveIdx < newMeta.length ? cur.liveIdx : 0;
      if (idx !== cur.liveIdx) setLiveIdx(idx);
      const r = await client.loadLive(idx, { forceRefresh: true });
      const newGroups = r.groups;
      if (!cur.groupName || !cur.channelName) { setGroups(newGroups); return; }
      const curGroup = newGroups.find((g) => g.group === cur.groupName);
      const curChannel = curGroup?.channels.find((c) => c.name === cur.channelName);
      if (!curGroup || !curChannel) return;
      setGroups(newGroups);
      const newLine = splitLine(curChannel.urls[cur.lineIdx] || curChannel.urls[0], cur.lineIdx + 1);
      const newUrl = newLine.url || '';
      if (newUrl && newUrl !== cur.playUrl) setPlayUrl(newUrl);
    } catch (e) { console.warn('[Live] 处理订阅更新失败：', e); }
  }, []);

  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:subscriptions-changed', (payload?: LiveSubChangedPayload) => {
      void loadSubStatus();
      if (!payload) { void reloadLives(); return; }
      if (!payload.updated) { if (payload.reason === 'crud') void reloadLives(); return; }
      void applySubscriptionUpdate();
    });
    return () => { if (typeof off === 'function') off(); };
  }, [loadSubStatus, reloadLives, applySubscriptionUpdate]);

  useEffect(() => {
    const w = window as any;
    const off = w?.winboxIpc?.on?.('live:changed', () => {
      void (async () => {
        try {
          const m = await client.liveMeta(); setLives(m);
          const idx = liveIdx < m.length ? liveIdx : 0;
          if (idx !== liveIdx) setLiveIdx(idx);
          if (m.length) await loadLiveInternal(idx, m);
        } catch (e) { console.warn('[Live] live:changed 处理后失败：', e); }
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
    outer: for (const g of gs) { for (const c of g.channels) {
      if (c.name !== currentChannelName) continue;
      const r: EpgChannelRef = { tvgId: c['tvg-id'], tvgName: c['tvg-name'], name: c.name, epg: c.epg };
      if (r.tvgId || r.tvgName || r.name) refs.push(r);
      break outer;
    } }
    if (!refs.length) { setEpg({}); setEpgStatus('empty'); return; }
    setEpgStatus('loading');
    try {
      const r = await client.liveEpg(index, refs);
      setEpg(r.byKey);
      setEpgStatus(Object.keys(r.byKey).length ? 'ok' : 'empty');
    } catch (e) { setEpg({}); setEpgStatus('error'); console.warn('[EPG] 加载失败：', e); }
  }

  useEffect(() => { if (!groups.length) return; void refreshEpg(liveIdx, groups, channelName); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [liveIdx, groups, channelName]);

  useEffect(() => {
    if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; }
    if (!curChannel) return;
    const e = epg[curChannel['tvg-id']] || epg[curChannel['tvg-name']] || epg[curChannel.name];
    const at = e?.current?.endTime ?? e?.next?.startTime;
    if (!at) return;
    const delay = Math.max(1000, Math.min(at - Date.now() + 1000, 6 * 3600 * 1000));
    epgTimer.current = window.setTimeout(() => { void refreshEpg(liveIdx, groups, channelName); }, delay);
    return () => { if (epgTimer.current != null) { window.clearTimeout(epgTimer.current); epgTimer.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epg, groupName, channelName, liveIdx]);

  async function openPrograms(channel: { name: string; 'tvg-id'?: string; 'tvg-name'?: string }) {
    const name = (channel.name || '').trim(); if (!name) return;
    const groupList = groups.map((g) => ({
      group: String(g.group || '').trim(),
      channels: g.channels.map((c) => ({ name: String(c.name || '').trim(), tvgId: String(c['tvg-id'] || '').trim(), tvgName: String(c['tvg-name'] || '').trim() })).filter((c) => !!c.name),
    })).filter((g) => !!g.group && g.channels.length > 0);
    try { await ipcInvoke(IPC.EPG_OPEN_WINDOW, { channelName: name, tvgId: (channel['tvg-id'] || '').trim(), tvgName: (channel['tvg-name'] || '').trim(), groups: groupList, currentGroup: groupName }); }
    catch (e) { console.warn('[EPG] 打开节目单窗口失败', e); }
  }

  const epgStatusText = epgStatus === 'loading' ? '加载中…' : epgStatus === 'ok' ? `命中 ${Object.keys(epg).length} 键` : epgStatus === 'empty' ? '无节目单' : epgStatus === 'error' ? '失败（看日志）' : '未触发';

  return (
    <>
      <div className="topbar">
        <select value={liveIdx} onChange={(e) => pickLive(Number(e.target.value))} disabled={loading}>
          {lives.map((l, i) => <option key={i} value={i}>{l.name}</option>)}
        </select>
        <span className="status" style={{ marginLeft: 'auto' }}>{loading ? '加载中…' : `${groups.length} 组`}</span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>订阅 {subEnabled}/{subCount}</span>
        <span className="status" style={{ marginLeft: 12, fontSize: 12, opacity: 0.7 }}>EPG：{epgStatusText}</span>
      </div>

      <div className="layout-2 content" style={{ padding: 12 }}>
        <div className="left">
          {groups.map((g) => (
            <div key={g.group} className={`nav-item ${g.group === groupName ? 'active' : ''}`}
              onClick={() => { setGroupName(g.group); if (g.channels.length) pickChannel(g, g.channels[0].name, 0, groups); }}>
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
                  <span key={c.name} className={`tag ${c.name === channelName ? 'active' : ''}`}
                    onClick={() => pickChannel(curGroup, c.name, 0, groups)} onDoubleClick={() => openPrograms(c)}
                    title="双击查看完整节目单（独立窗口，可拖到屏幕任意位置）">{c.name}</span>
                ))}
              </div>
              {lines.length > 1 && (
                <div className="row" style={{ marginBottom: 8 }}>
                  <span className="muted">线路：</span>
                  {lines.map((l) => (
                    <span key={l.index} className={`tag ${l.index - 1 === lineIdx ? 'active' : ''}`}
                      onClick={() => {
                        setLineIdx(l.index - 1);
                        setPlayUrl(l.url);
                        saveLiveMem({ liveIdx, groupName, channelName, lineIdx: l.index - 1 });
                        openLivePlayer(l.url, channelName);
                      }}>
                      {l.name}
                    </span>
                  ))}
                </div>
              )}
              {curEpg && (curEpg.current || curEpg.next) && curChannel && (
                <div className="live-epg" onClick={() => openPrograms(curChannel)} style={{ cursor: 'pointer' }} title="点击查看完整节目单（独立窗口，可拖到屏幕任意位置）">
                  {curEpg.current && <span className="live-epg-now"><b>正在播</b> {curEpg.current.start}~{curEpg.current.end} {curEpg.current.title || '（无标题）'}</span>}
                  {curEpg.next && <span className="muted"><b>下一档</b> {curEpg.next.start} {curEpg.next.title || '（无标题）'}</span>}
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>📺</span>
                </div>
              )}

              {playUrl ? (
                <div className="live-player" style={{ position: 'relative', minHeight: 260, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, background: '#000', color: '#ccc', borderRadius: 8, padding: 16, textAlign: 'center' }}>
                  <div style={{ fontSize: 16, fontWeight: 600 }}>{channelName || '直播'}</div>
                  <div style={{ fontSize: 12, opacity: 0.7, maxWidth: '85%', wordBreak: 'break-all' }}>{playUrl}</div>
                  <div style={{ fontSize: 12, opacity: 0.55 }}>
                    直播由独立播放器窗口（mpv 内核）播放 · 流类型 {detectStreamType(playUrl) === 'hls' ? 'HLS' : detectStreamType(playUrl) === 'ts' ? 'TS（已启用快速探测）' : '其他'}
                  </div>
                  <button type="button" onClick={() => openLivePlayer(playUrl, channelName)}
                    style={{ padding: '6px 18px', borderRadius: 6, border: '1px solid #555', background: '#1f1f1f', color: '#eee', cursor: 'pointer' }}>
                    用 mpv 打开
                  </button>
                </div>
              ) : (<div className="empty">无播放地址</div>)}
            </>
          ) : (<div className="empty">{groups.length ? '选择左侧分组' : '无直播（请先导入含 lives 的配置）'}</div>)}
        </div>
      </div>
    </>
  );
}
