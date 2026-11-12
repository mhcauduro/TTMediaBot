import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { ClientType, Innertube, UniversalCache, Platform } from 'youtubei.js';
import { ExpiringLruCache } from './cache.mjs';
import { musicItemPayload, normalizeSearchKey, streamCacheTtlMs } from './media.mjs';

const HOST = process.env.YOUTUBE_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.YOUTUBE_BRIDGE_PORT || 4417);
const POT_URL = process.env.POT_PROVIDER_URL || 'http://127.0.0.1:4416/get_pot';
const BOTS_ROOT = path.resolve(process.env.TTMEDIABOT_BOTS_ROOT || '/bots');
const USER_AGENT = process.env.YOUTUBE_BRIDGE_USER_AGENT ||
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1';

// YouTube.js 18 requires an evaluator to decipher player signatures/nsig.
Platform.shim.eval = async (data) => new Function(data.output)();

const SESSION_CACHE_MAX_ENTRIES = 64;
const sessionCache = new Map();
let searchSessionPromise = null;
const RESOLVE_CACHE_MAX_ENTRIES = 1024;
const resolveCache = new ExpiringLruCache({ maxEntries: RESOLVE_CACHE_MAX_ENTRIES });
const pendingResolutions = new Map();
const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const searchCache = new ExpiringLruCache({ maxEntries: 2048 });
const RECOMMENDATION_CACHE_TTL_MS = 30 * 60 * 1000;
const recommendationCache = new ExpiringLruCache({ maxEntries: 512 });

const DISK_CACHE_FILE = path.resolve(process.env.BRIDGE_CACHE_FILE || path.join(path.dirname(new URL(import.meta.url).pathname), 'bridge_cache.json'));

async function loadDiskCache() {
  try {
    const raw = await fs.readFile(DISK_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.search) searchCache.load(parsed.search);
    if (parsed.resolve) resolveCache.load(parsed.resolve);
    console.log(`[youtube-bridge] Loaded persistent disk cache (search: ${searchCache.size}, resolve: ${resolveCache.size})`);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn('[youtube-bridge] Could not load disk cache:', err.message);
    }
  }
}

let saveTimer = null;
function scheduleSaveDiskCache() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const data = {
        search: searchCache.dump(),
        resolve: resolveCache.dump()
      };
      await fs.writeFile(DISK_CACHE_FILE, JSON.stringify(data), 'utf8');
    } catch (err) {
      console.warn('[youtube-bridge] Could not save disk cache:', err.message);
    }
  }, 2000);
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function getBotCookieFile(botId) {
  if (typeof botId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(botId)) {
    throw new Error('Invalid or missing bot_id');
  }
  return path.join(BOTS_ROOT, botId, 'cookies.txt');
}

function cookieFileKey(cookieFile) {
  if (!cookieFile) return 'anonymous';
  try {
    const stat = statSync(cookieFile);
    return `${cookieFile}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${cookieFile}:missing`;
  }
}

async function netscapeCookiesToHeader(cookieFile) {
  if (!cookieFile) return '';
  let text;
  try {
    text = await fs.readFile(cookieFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }

  const cookies = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    else if (line.startsWith('#')) continue;

    const parts = line.split('\t');
    if (parts.length < 7) continue;
    const domain = parts[0].toLowerCase().replace(/^\./, '');
    if (domain !== 'youtube.com' && !domain.endsWith('.youtube.com')) continue;
    const name = parts[5];
    const value = parts.slice(6).join('\t');
    if (name) cookies.set(name, value);
  }
  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
}

function pageConfigValue(page, key) {
  const match = page.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

// YouTube's mobile home page ships >16 KiB of response headers (many Set-Cookie
// entries). Node's built-in fetch/undici defaults to a 16 KiB maxHeaderSize and
// throws UND_ERR_HEADERS_OVERFLOW, which used to break every resolve/download.
// Use node:https with an explicit, generous limit instead.
const SESSION_PAGE_MAX_HEADER_SIZE = 1024 * 1024;
const SESSION_PAGE_TIMEOUT_MS = 15000;

function httpsGetText(url, headers, { maxHeaderSize = SESSION_PAGE_MAX_HEADER_SIZE, timeoutMs = SESSION_PAGE_TIMEOUT_MS, redirectsLeft = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers,
      maxHeaderSize
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
        response.resume();
        resolve(httpsGetText(new URL(response.headers.location, target).toString(), headers, {
          maxHeaderSize,
          timeoutMs,
          redirectsLeft: redirectsLeft - 1
        }));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status,
        ok: status >= 200 && status < 300,
        body: Buffer.concat(chunks).toString('utf8')
      }));
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('YouTube session page request timed out'));
    });
    request.on('error', reject);
    request.end();
  });
}

async function getWebSessionData(cookie) {
  if (!cookie) return {};
  try {
    const response = await httpsGetText('https://m.youtube.com/', {
      'Cookie': cookie,
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9'
    });
    if (!response.ok) {
      throw new Error(`YouTube session page returned HTTP ${response.status}`);
    }
    return {
      dataSyncId: pageConfigValue(response.body, 'DATASYNC_ID'),
      visitorData: pageConfigValue(response.body, 'VISITOR_DATA')
    };
  } catch (error) {
    // Session enrichment is optional (visitor data / data sync id). Never let it
    // take resolve, info or download down; Innertube can still create a session.
    console.warn(`[youtube-bridge] Could not read YouTube web session data (${error?.code || error?.message}); continuing without visitor data`);
    return {};
  }
}

async function getSession(cookieFile) {
  const key = cookieFileKey(cookieFile);
  const cached = sessionCache.get(key);
  if (cached) {
    sessionCache.delete(key);
    sessionCache.set(key, cached);
    return cached;
  }

  for (const cachedKey of sessionCache.keys()) {
    if (cachedKey.startsWith(`${cookieFile}:`)) sessionCache.delete(cachedKey);
  }

  const contextPromise = (async () => {
    const cookie = await netscapeCookiesToHeader(cookieFile);
    const webSession = await getWebSessionData(cookie);
    const session = await Innertube.create({
      cookie: cookie || undefined,
      user_agent: USER_AGENT,
      client_type: ClientType.MWEB,
      visitor_data: webSession.visitorData,
      cache: new UniversalCache(true),
      enable_session_cache: true,
      generate_session_locally: true,
      retrieve_player: true
    });
    return { session };
  })().catch((error) => {
    sessionCache.delete(key);
    throw error;
  });

  sessionCache.set(key, contextPromise);
  while (sessionCache.size > SESSION_CACHE_MAX_ENTRIES) {
    sessionCache.delete(sessionCache.keys().next().value);
  }
  return contextPromise;
}

async function getSearchSession() {
  if (!searchSessionPromise) {
    searchSessionPromise = Innertube.create({
      client_type: ClientType.WEB,
      cache: new UniversalCache(true),
      enable_session_cache: true,
      generate_session_locally: true,
      retrieve_player: false,
      fail_fast: true
    }).catch((error) => {
      searchSessionPromise = null;
      throw error;
    });
  }
  return searchSessionPromise;
}

async function getPoToken(contentBinding) {
  try {
    const response = await fetch(POT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content_binding: contentBinding })
    });
    if (!response.ok) {
      const body = await response.text();
      console.warn(`[youtube-bridge] POT provider HTTP ${response.status}: ${body.slice(0, 300)}`);
      return undefined;
    }
    const data = await response.json();
    return data.poToken || data.po_token || undefined;
  } catch (error) {
    console.warn(`[youtube-bridge] POT provider unavailable: ${error.message}`);
    return undefined;
  }
}

function extractVideoId(input) {
  if (!input) return null;
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.hostname === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const shorts = url.pathname.match(/^\/shorts\/([^/?]+)/);
    if (shorts) return shorts[1];
  } catch {}
  return null;
}

async function extractPlaylistId(input, session) {
  if (!input) return null;
  if (/^[A-Za-z0-9_-]{18,50}$/.test(input)) {
    if (input.startsWith('UC') && input.length === 24) {
      return 'UU' + input.slice(2);
    }
    return input;
  }
  try {
    const url = new URL(input);
    const listParam = url.searchParams.get('list');
    if (listParam) return listParam;

    const channelMatch = url.pathname.match(/\/channel\/(UC[A-Za-z0-9_-]{22})/);
    if (channelMatch) {
      return 'UU' + channelMatch[1].slice(2);
    }

    if (session && (url.pathname.includes('@') || url.pathname.includes('/c/') || url.pathname.includes('/user/') || url.pathname.includes('/channel/'))) {
      try {
        const res = await session.resolveURL(input);
        const browseId = res?.payload?.browseId || res?.endpoint?.payload?.browseId;
        if (browseId && browseId.startsWith('UC')) {
          return 'UU' + browseId.slice(2);
        } else if (browseId) {
          return browseId;
        }
      } catch (e) {
        console.warn(`[youtube-bridge] resolveURL failed for ${input}: ${e.message}`);
      }
    }
  } catch {}
  return null;
}

function textValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.toString === 'function') return value.toString();
  return '';
}

function ownerName(info) {
  const basic = info?.basic_info || {};
  return textValue(basic.author) || textValue(basic.channel?.name) || '';
}

function infoPayload(info, videoId) {
  const basic = info?.basic_info || {};
  return {
    id: basic.id || videoId,
    videoId: basic.id || videoId,
    title: basic.title || '',
    uploader: ownerName(info),
    duration: basic.duration || 0,
    is_live: Boolean(basic.is_live || basic.is_live_content),
    webpage_url: `https://www.youtube.com/watch?v=${basic.id || videoId}`,
    http_headers: { 'User-Agent': USER_AGENT }
  };
}

function formatPayload(format) {
  return {
    url: format.url,
    itag: format.itag,
    mime_type: format.mime_type,
    bitrate: format.bitrate,
    average_bitrate: format.average_bitrate,
    content_length: format.content_length,
    quality: format.quality,
    quality_label: format.quality_label,
    audio_quality: format.audio_quality,
    audio_sample_rate: format.audio_sample_rate,
    audio_channels: format.audio_channels,
    has_audio: format.has_audio,
    has_video: format.has_video
  };
}

async function getPlayableInfo(session, videoId, client, poToken) {
  const targetClient = client === 'YTMUSIC' ? ClientType.MWEB : client;
  return session.getBasicInfo(videoId, { client: targetClient, po_token: poToken });
}

function playabilityDescription(info) {
  const status = info?.playability_status?.status || 'UNKNOWN';
  const reason = info?.playability_status?.reason || '';
  return reason ? `${status}: ${reason}` : status;
}

async function resolveFormat(context, videoId, requestedClient, formatOptions) {
  // WEB is SABR-only for many videos in 2026. MWEB still exposes classic
  // adaptive formats and is the preferred web playback client here.
  const clients = requestedClient === 'YTMUSIC'
    ? ['YTMUSIC', 'MWEB', ClientType.TV_EMBEDDED]
    : ['MWEB', ClientType.TV_EMBEDDED];
  const failures = [];
  const { session } = context;

  for (const client of clients) {
    const clientStartedAt = performance.now();
    try {
      const poStartedAt = performance.now();
      const poToken = client === ClientType.TV_EMBEDDED
        ? undefined
        : await getPoToken(videoId);
      console.log(`[youtube-bridge-timing] video=${videoId} client=${client} stage=po-token elapsed_ms=${Math.round(performance.now() - poStartedAt)} available=${Boolean(poToken)}`);

      const playerStartedAt = performance.now();
      const info = await getPlayableInfo(session, videoId, client, poToken);
      console.log(`[youtube-bridge-timing] video=${videoId} client=${client} stage=player elapsed_ms=${Math.round(performance.now() - playerStartedAt)} status=${info?.playability_status?.status || 'UNKNOWN'}`);
      if (!info?.streaming_data) {
        throw new Error(`no streaming data (${playabilityDescription(info)})`);
      }

      const formatStartedAt = performance.now();
      const format = info.chooseFormat(formatOptions);
      console.log(`[youtube-bridge-timing] video=${videoId} client=${client} stage=choose-format elapsed_ms=${Math.round(performance.now() - formatStartedAt)} itag=${format.itag}`);
      if (!session.session.player) {
        throw new Error('YouTube player is unavailable');
      }

      session.session.player.po_token = poToken;
      const decipherStartedAt = performance.now();
      format.url = await format.decipher(session.session.player);
      console.log(`[youtube-bridge-timing] video=${videoId} client=${client} stage=decipher elapsed_ms=${Math.round(performance.now() - decipherStartedAt)}`);

      if (!format.url) {
        throw new Error('decipher returned an empty stream URL');
      }

      console.log(`[youtube-bridge] resolved ${videoId} with client=${client} itag=${format.itag} elapsed_ms=${Math.round(performance.now() - clientStartedAt)}`);
      return { info, format, client };
    } catch (error) {
      const message = error?.message || String(error);
      failures.push(`${client}: ${message}`);
      console.warn(`[youtube-bridge] ${videoId} client=${client} failed: ${message}`);
    }
  }

  throw new Error(`Unable to resolve stream for ${videoId}; ${failures.join(' | ')}`);
}

async function resolveTrack(body) {
  const startedAt = performance.now();
  const videoId = body.video_id || extractVideoId(body.url);
  if (!videoId) throw new Error('Invalid YouTube URL or video ID');
  const requestedClient = body.client === 'YTMUSIC' ? 'YTMUSIC' : 'MWEB';
  const cacheKey = `${cookieFileKey(body.cookie_file)}:${requestedClient}:${videoId}`;
  const cached = resolveCache.get(cacheKey);
  if (cached) {
    console.log(`[youtube-bridge] resolve cache hit ${videoId} client=${requestedClient} elapsed_ms=${Math.round(performance.now() - startedAt)} cache_entries=${resolveCache.size}`);
    return cached;
  }
  console.log(`[youtube-bridge] resolve cache miss ${videoId} client=${requestedClient} cache_entries=${resolveCache.size}`);

  const pending = pendingResolutions.get(cacheKey);
  if (pending) {
    console.log(`[youtube-bridge] joining pending resolve ${videoId} client=${requestedClient} pending=${pendingResolutions.size}`);
    return pending;
  }

  const resolution = resolveTrackUncached(body, videoId, requestedClient)
    .then((payload) => {
      const ttlMs = streamCacheTtlMs(payload.url);
      const cachedPayload = {
        ...payload,
        cache_expires_at_ms: Date.now() + ttlMs
      };
      resolveCache.set(cacheKey, cachedPayload, ttlMs);
      scheduleSaveDiskCache();
      console.log(`[youtube-bridge] resolve completed ${videoId} client=${requestedClient} elapsed_ms=${Math.round(performance.now() - startedAt)} ttl_ms=${Math.round(ttlMs)} cache_entries=${resolveCache.size}`);
      return cachedPayload;
    })
    .finally(() => pendingResolutions.delete(cacheKey));
  pendingResolutions.set(cacheKey, resolution);
  return resolution;
}

function invalidateResolution(body) {
  const videoId = body.video_id || extractVideoId(body.url);
  if (!videoId) throw new Error('Invalid YouTube URL or video ID');
  const requestedClient = body.client === 'YTMUSIC' ? 'YTMUSIC' : 'MWEB';
  const cacheKey = `${cookieFileKey(body.cookie_file)}:${requestedClient}:${videoId}`;
  resolveCache.delete(cacheKey);
  pendingResolutions.delete(cacheKey);
  console.log(`[youtube-bridge] resolve cache invalidated ${videoId} client=${requestedClient}`);
  return { invalidated: true };
}

async function resolveTrackUncached(body, videoId, requestedClient) {
  const context = await getSession(body.cookie_file);

  const { info, format, client } = await resolveFormat(context, videoId, requestedClient, {
    type: 'audio',
    quality: 'best',
    format: 'any'
  });

  const metadata = infoPayload(info, videoId);
  return {
    ...metadata,
    ...formatPayload(format),
    client,
    format: 'mp3',
    http_headers: { 'User-Agent': USER_AGENT }
  };
}

async function getInfo(body) {
  const videoId = body.video_id || extractVideoId(body.url);
  if (!videoId) throw new Error('Invalid YouTube URL or video ID');
  const context = await getSession(body.cookie_file);
  const client = body.client === 'YTMUSIC' ? 'YTMUSIC' : 'MWEB';
  const poToken = await getPoToken(context.poBinding || videoId);
  const info = await getPlayableInfo(context.session, videoId, client, poToken);
  return {
    ...infoPayload(info, videoId),
    playability_status: info?.playability_status?.status || '',
    playability_reason: info?.playability_status?.reason || ''
  };
}

async function getWebSession(cookieFile) {
  const cookie = await netscapeCookiesToHeader(cookieFile);
  return await Innertube.create({
    cookie: cookie || undefined,
    user_agent: USER_AGENT,
    client_type: ClientType.WEB,
    cache: new UniversalCache(true),
    enable_session_cache: true,
    generate_session_locally: true,
    retrieve_player: false
  });
}

async function getPlaylist(body) {
  const session = await getWebSession(body.cookie_file);
  const playlistId = body.playlist_id || (await extractPlaylistId(body.url, session));
  if (!playlistId) throw new Error('Invalid YouTube playlist URL or ID');
  const playlist = await session.getPlaylist(playlistId);
  const allItems = [...(playlist?.items || playlist?.videos || [])];

  let current = playlist;
  while (current?.has_continuation) {
    try {
      current = await current.getContinuation();
      const pageItems = current?.items || current?.videos || [];
      if (!pageItems.length) break;
      allItems.push(...pageItems);
    } catch (error) {
      console.warn(`[youtube-bridge] Playlist pagination completed or stopped: ${error.message}`);
      break;
    }
  }

  console.log(`[youtube-bridge] playlist ${playlistId} fetched ${allItems.length} total items across all pages`);

  const defaultUploader = textValue(playlist?.info?.author?.name) || textValue(playlist?.info?.title) || '';

  return {
    id: playlistId,
    title: textValue(playlist?.info?.title),
    uploader: defaultUploader,
    entries: allItems.map((item) => {
      let id = item.id || item.video_id || item.content_id;
      if (!id || id.length !== 11) {
        const str = JSON.stringify(item);
        const match = str.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
        if (match) id = match[1];
      }
      const title = textValue(item.title?.text || item.title || item.metadata?.title?.text || item.metadata?.title);
      const uploader = textValue(item.author?.name || item.author?.text || item.author || item.metadata?.author?.name || item.short_by_line_text) || defaultUploader;
      return {
        id,
        videoId: id,
        title,
        uploader,
        webpage_url: id ? `https://www.youtube.com/watch?v=${id}` : ''
      };
    }).filter((item) => item.id && item.id.length === 11)
  };
}

async function searchVideos(body) {
  const query = String(body.query || '').trim();
  if (!query) throw new Error('Search query is required');
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 50);
  const mode = body.mode === 'music' ? 'music' : 'video';
  const startedAt = performance.now();
  const cacheKey = normalizeSearchKey(mode, query);
  const cached = searchCache.get(cacheKey);
  if (cached) {
    console.log(`[youtube-bridge] search cache hit mode=${mode} query="${query}" elapsed_ms=${Math.round(performance.now() - startedAt)}`);
    return { entries: cached.slice(0, limit) };
  }

  const entries = await searchCache.getOrCreate(cacheKey, SEARCH_CACHE_TTL_MS, async () => {
    const session = await getSearchSession();
    try {
      if (mode === 'music') {
        const rawRes = await session.actions.execute('/search', {
          query,
          params: 'Eg-KAQwIARAAGAAgACgAMABqChAEEAMQCRAFEAo%3D',
          client: 'YTMUSIC'
        });
        const tab = rawRes.data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer;
        const sections = tab?.content?.sectionListRenderer?.contents || [];
        const ytmEntries = [];
        for (const sec of sections) {
          const items = sec?.musicShelfRenderer?.contents || sec?.musicCardShelfRenderer?.contents || [];
          for (const item of items) {
            const r = item?.musicResponsiveListItemRenderer;
            if (!r) continue;
            const flexCols = r.flexColumns || [];
            const title = flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
            const artist = flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text;
            const videoId = r.playlistItemData?.videoId || r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
            if (videoId) {
              ytmEntries.push({
                id: videoId,
                videoId,
                title: title || 'Unknown Title',
                uploader: artist || '',
                webpage_url: `https://www.youtube.com/watch?v=${videoId}`
              });
            }
          }
        }
        if (ytmEntries.length > 0) return ytmEntries.slice(0, 50);
      } else {
        const rawRes = await session.actions.execute('/search', {
          query,
          params: 'EgIQAQ%3D%3D',
          client: 'WEB'
        });
        const ytContents = rawRes.data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
        const ytEntries = [];
        for (const sec of ytContents) {
          const items = sec?.itemSectionRenderer?.contents || [];
          for (const item of items) {
            const v = item?.videoRenderer;
            if (!v || !v.videoId) continue;
            const title = v.title?.runs?.[0]?.text || v.title?.simpleText;
            const uploader = v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text;
            ytEntries.push({
              id: v.videoId,
              videoId: v.videoId,
              title: title || 'Unknown Title',
              uploader: uploader || '',
              webpage_url: `https://www.youtube.com/watch?v=${v.videoId}`
            });
          }
        }
        if (ytEntries.length > 0) return ytEntries.slice(0, 50);
      }
    } catch (rawErr) {
      console.warn(`[youtube-bridge] Fast raw search failed for "${query}", falling back to parser:`, rawErr.message);
    }

    if (mode === 'music') {
      const search = await session.music.search(query, { type: 'song' });
      const items = search?.songs?.contents || search?.contents || [];
      return items
        .map(musicItemPayload)
        .filter(Boolean)
        .slice(0, 50);
    }
    const search = await session.search(query, { type: 'video' });
    const items = search?.videos || search?.results || search?.contents || [];
    return items.slice(0, 50).map((video) => ({
      id: video.id || video.videoId,
      videoId: video.id || video.videoId,
      title: textValue(video.title),
      uploader: textValue(video.author?.name || video.author?.text || video.author),
      webpage_url: (video.id || video.videoId) ? `https://www.youtube.com/watch?v=${video.id || video.videoId}` : ''
    })).filter((video) => video.id);
  });
  console.log(`[youtube-bridge] searched mode=${mode} query="${query}" in ${Math.round(performance.now() - startedAt)}ms cache_entries=${searchCache.size}`);
  scheduleSaveDiskCache();

  const results = entries.slice(0, limit);
  if (limit === 1 && results.length > 0) {
    const topVideoId = results[0].videoId || results[0].id;
    if (topVideoId) {
      const requestedClient = mode === 'music' ? 'YTMUSIC' : 'MWEB';
      const cacheKey = `${cookieFileKey(body.cookie_file)}:${requestedClient}:${topVideoId}`;
      const cached = resolveCache.get(cacheKey);
      if (cached && cached.url) {
        results[0] = {
          ...results[0],
          ...cached,
          stream_url: cached.url
        };
      } else {
        try {
          const resolved = await resolveTrack({
            video_id: topVideoId,
            client: requestedClient,
            cookie_file: body.cookie_file
          });
          if (resolved && resolved.url) {
            results[0] = {
              ...results[0],
              ...resolved,
              stream_url: resolved.url
            };
          }
        } catch (err) {
          console.warn(`[youtube-bridge] pre-resolve in search failed for ${topVideoId}: ${err.message}`);
        }
      }
    }
  }

  return { entries: results };
}

async function getMusicRecommendations(body) {
  const videoId = body.video_id || extractVideoId(body.url);
  if (!videoId) throw new Error('Invalid YouTube URL or video ID');
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
  const cacheKey = `${cookieFileKey(body.cookie_file)}:${videoId}`;
  const startedAt = performance.now();
  const cached = recommendationCache.get(cacheKey);
  if (cached) {
    console.log(`[youtube-bridge] recommendations cache hit ${videoId} elapsed_ms=${Math.round(performance.now() - startedAt)}`);
    return { entries: cached.slice(0, limit) };
  }

  const entries = await recommendationCache.getOrCreate(
    cacheKey,
    RECOMMENDATION_CACHE_TTL_MS,
    async () => {
      const { session } = await getSession(body.cookie_file);
      try {
        const playlist = await session.music.getUpNext(videoId, true);
        return (playlist?.contents || [])
          .map(musicItemPayload)
          .filter((item) => item && item.videoId !== videoId)
          .slice(0, 50);
      } catch (err) {
        console.warn(`[youtube-bridge] getUpNext(automix) failed for ${videoId}: ${err.message}. Retrying standard upNext...`);
        try {
          const fallbackPlaylist = await session.music.getUpNext(videoId, false);
          return (fallbackPlaylist?.contents || [])
            .map(musicItemPayload)
            .filter((item) => item && item.videoId !== videoId)
            .slice(0, 50);
        } catch (fallbackErr) {
          console.warn(`[youtube-bridge] getUpNext fallback failed for ${videoId}: ${fallbackErr.message}`);
          return [];
        }
      }
    }
  );
  console.log(`[youtube-bridge] recommendations completed ${videoId} elapsed_ms=${Math.round(performance.now() - startedAt)} cache_entries=${recommendationCache.size}`);
  return { entries: entries.slice(0, limit) };
}

async function getDownloadPlan(body) {
  const videoId = body.video_id || extractVideoId(body.url);
  if (!videoId) throw new Error('Invalid YouTube URL or video ID');
  const context = await getSession(body.cookie_file);
  const requestedClient = body.client === 'YTMUSIC' ? 'YTMUSIC' : 'MWEB';

  if (!body.video) {
    const { format: audio, client } = await resolveFormat(context, videoId, requestedClient, {
      type: 'audio', quality: 'best', format: 'any'
    });
    return {
      audio: formatPayload(audio),
      client,
      http_headers: { 'User-Agent': USER_AGENT }
    };
  }

  let videoResult;
  try {
    videoResult = await resolveFormat(context, videoId, requestedClient, {
      type: 'video', quality: 'best', format: 'mp4'
    });
  } catch {
    videoResult = await resolveFormat(context, videoId, requestedClient, {
      type: 'video', quality: 'best', format: 'any'
    });
  }

  let audioResult;
  try {
    audioResult = await resolveFormat(context, videoId, requestedClient, {
      type: 'audio', quality: 'best', format: 'mp4'
    });
  } catch {
    audioResult = await resolveFormat(context, videoId, requestedClient, {
      type: 'audio', quality: 'best', format: 'any'
    });
  }

  return {
    video: formatPayload(videoResult.format),
    audio: formatPayload(audioResult.format),
    client: `${videoResult.client}/${audioResult.client}`,
    http_headers: { 'User-Agent': USER_AGENT }
  };
}

// ---------------------------------------------------------------------------
// Range-chunked streaming proxy
//
// googlevideo now answers 403 to any request that is not a *bounded* Range
// request of at most 1 MiB ("rqh=1" PO-token enforcement). ffmpeg/libmpv always
// open a remote file with `Range: bytes=0-` (or without any Range header), so
// every track died right after `start-file` with "loading failed (reason 4)".
//
// Instead of handing the googlevideo URL to mpv, /resolve and /download-plan
// return a bridge URL. The bridge fetches the upstream media in <=1 MiB chunks
// and exposes it as a regular HTTP resource with full Range support, so mpv and
// ffmpeg keep working unchanged.
// ---------------------------------------------------------------------------
const STREAM_CHUNK_SIZE = 1024 * 1024;
const STREAM_TTL_MS = 6 * 60 * 60 * 1000;
const STREAM_REGISTRY_MAX = 4096;
const streamRegistry = new Map();
let streamSequence = 0;

function registerStreamDescriptor(payload) {
  const now = Date.now();
  for (const [key, value] of streamRegistry) {
    if (value.expiresAt <= now) streamRegistry.delete(key);
  }
  while (streamRegistry.size >= STREAM_REGISTRY_MAX) {
    streamRegistry.delete(streamRegistry.keys().next().value);
  }

  const id = `${(streamSequence++).toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  streamRegistry.set(id, {
    url: payload.url,
    mimeType: payload.mime_type || 'application/octet-stream',
    contentLength: Number(payload.content_length) || 0,
    headers: payload.http_headers || {},
    expiresAt: now + STREAM_TTL_MS
  });
  return id;
}

function proxiedStreamUrl(req, payload) {
  const host = req?.headers?.host || `${HOST}:${PORT}`;
  return `http://${host}/stream/${registerStreamDescriptor(payload)}`;
}

function parseByteRange(headerValue, total) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(headerValue || '').trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start > end || start >= total) return null;
  return { start, end };
}

function upstreamRequestHeaders(descriptor, start, end) {
  const headers = {
    'accept': '*/*',
    'accept-encoding': 'identity',
    'user-agent': USER_AGENT,
    'range': `bytes=${start}-${end}`
  };
  for (const [key, value] of Object.entries(descriptor.headers || {})) {
    if (key.toLowerCase() !== 'user-agent') headers[key.toLowerCase()] = value;
  }
  return headers;
}

function fetchUpstreamRange(descriptor, start, end) {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(descriptor.url), {
      method: 'GET',
      headers: upstreamRequestHeaders(descriptor, start, end)
    }, resolve);
    request.on('error', reject);
    request.setTimeout(30000, () => request.destroy(new Error('Upstream request timed out')));
    request.end();
  });
}

async function probeUpstreamContentLength(descriptor) {
  const upstream = await fetchUpstreamRange(descriptor, 0, 0);
  const status = upstream.statusCode || 0;
  try {
    if (status === 206) {
      const match = /\/(\d+)\s*$/.exec(upstream.headers['content-range'] || '');
      if (match) return Number(match[1]);
    }
    if (status === 200) return Number(upstream.headers['content-length']) || 0;
    throw new Error(`Upstream probe responded HTTP ${status}`);
  } finally {
    upstream.resume();
  }
}

async function pipeUpstreamChunks(descriptor, res, start, end) {
  let position = start;
  while (position <= end && !res.destroyed) {
    const chunkEnd = Math.min(position + STREAM_CHUNK_SIZE - 1, end);
    const upstream = await fetchUpstreamRange(descriptor, position, chunkEnd);
    const status = upstream.statusCode || 0;
    if (status !== 206 && status !== 200) {
      upstream.resume();
      throw new Error(`Upstream responded HTTP ${status}`);
    }
    if (status === 200 && position > 0) {
      upstream.resume();
      throw new Error('Upstream ignored the Range header');
    }

    const expected = chunkEnd - position + 1;
    let served = 0;
    for await (const chunk of upstream) {
      if (res.destroyed) {
        upstream.destroy();
        return;
      }
      const room = expected - served;
      if (room <= 0) break;
      const data = chunk.length > room ? chunk.subarray(0, room) : chunk;
      served += data.length;
      if (!res.write(data)) {
        await Promise.race([once(res, 'drain'), once(res, 'close')]);
      }
      if (res.destroyed) {
        upstream.destroy();
        return;
      }
    }
    if (status === 200) break;
    if (served === 0) break;
    position += served;
  }
}

async function handleStreamRequest(req, res, id) {
  const descriptor = streamRegistry.get(id);
  if (!descriptor || descriptor.expiresAt <= Date.now()) {
    streamRegistry.delete(id);
    return json(res, 404, { error: 'Stream not found or expired' });
  }

  if (!descriptor.contentLength) {
    descriptor.contentLength = await probeUpstreamContentLength(descriptor);
  }
  const total = descriptor.contentLength;
  if (!total) return json(res, 502, { error: 'Upstream did not report a content length' });

  const requested = parseByteRange(req.headers.range, total);
  const start = requested ? requested.start : 0;
  const end = requested ? requested.end : total - 1;

  res.writeHead(requested ? 206 : 200, {
    'content-type': descriptor.mimeType,
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
    'cache-control': 'no-store',
    ...(requested ? { 'content-range': `bytes ${start}-${end}/${total}` } : {})
  });
  if (req.method === 'HEAD') return res.end();

  try {
    await pipeUpstreamChunks(descriptor, res, start, end);
    res.end();
  } catch (error) {
    console.warn(`[youtube-bridge] stream ${id} failed: ${error.message}`);
    if (!res.headersSent) json(res, 502, { error: error.message });
    else res.destroy(error);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, { ok: true, version: '2' });
    }
    const streamMatch = (req.method === 'GET' || req.method === 'HEAD')
      ? /^\/stream\/([A-Za-z0-9]+)$/.exec(req.url || '')
      : null;
    if (streamMatch) return await handleStreamRequest(req, res, streamMatch[1]);
    if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });

    const body = await readBody(req);
    body.cookie_file = getBotCookieFile(body.bot_id);
    if (req.url === '/resolve') {
      const payload = { ...(await resolveTrack(body)) };
      if (payload.url) payload.url = proxiedStreamUrl(req, payload);
      return json(res, 200, payload);
    }
    if (req.url === '/invalidate') return json(res, 200, invalidateResolution(body));
    if (req.url === '/info') return json(res, 200, await getInfo(body));
    if (req.url === '/playlist') return json(res, 200, await getPlaylist(body));
    if (req.url === '/search') return json(res, 200, await searchVideos(body));
    if (req.url === '/recommendations') return json(res, 200, await getMusicRecommendations(body));
    if (req.url === '/download-plan') {
      const plan = await getDownloadPlan(body);
      for (const key of ['audio', 'video']) {
        const entry = plan?.[key];
        if (entry?.url) {
          entry.url = proxiedStreamUrl(req, { ...entry, http_headers: plan.http_headers });
        }
      }
      return json(res, 200, plan);
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error('[youtube-bridge]', error);
    return json(res, 500, { error: error?.message || String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[youtube-bridge] listening on http://${HOST}:${PORT}`);
  loadDiskCache().catch(() => {});
  // Background pre-warming for search session so first user request is instant
  getSearchSession().catch((err) => {
    console.warn('[youtube-bridge] Background search session warmup failed:', err?.message || err);
  });

  // Keep search socket connections warm periodically
  setInterval(async () => {
    try {
      const session = await getSearchSession();
      await session.music.search('ping', { type: 'song' }).catch(() => {});
    } catch {}
  }, 45000).unref();
});
