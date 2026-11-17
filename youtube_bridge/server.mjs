import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { ClientType, Innertube, UniversalCache, Platform } from 'youtubei.js';
import { ExpiringLruCache } from './cache.mjs';
import {
  DEVICE_FALLBACK_CLIENTS,
  LOGGED_IN_CLIENTS,
  PLAYER_CLIENTS,
  appendPoToken,
  buildSapisidAuthorization,
  extractSessionIndex,
  extractSignatureTimestamp,
  extractUserSessionId,
  extractVisitorData,
  isLoggedInPage,
  musicItemPayload,
  normalizeSearchKey,
  pickBestAudioFromPlayerJson,
  pickBestVideoFromPlayerJson,
  playerInfo,
  playerRequestBody,
  playerRequestHeaders,
  streamCacheTtlMs,
  validationProbeRanges
} from './media.mjs';

const HOST = process.env.YOUTUBE_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.YOUTUBE_BRIDGE_PORT || 4417);
const POT_URL = process.env.POT_PROVIDER_URL || 'http://127.0.0.1:4416/get_pot';
const BOTS_ROOT = path.resolve(process.env.TTMEDIABOT_BOTS_ROOT || '/bots');
const USER_AGENT = process.env.YOUTUBE_BRIDGE_USER_AGENT ||
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1';
const PLAYER_VISITOR_TTL_MS = 30 * 60 * 1000;
const PLAYER_REQUEST_TIMEOUT_MS = Number(process.env.YOUTUBE_BRIDGE_PLAYER_TIMEOUT_MS || 20000);
// The POT provider mints a valid GVS token only part of the time (the BotGuard
// challenge it fetches from YouTube is inconsistent). A rejected token is
// detected by the range validation, so mint a fresh one and retry. With the
// observed hit rate, eight attempts fail less than 1% of the time.
const LOGGED_IN_TOKEN_ATTEMPTS = Number(process.env.YOUTUBE_BRIDGE_TOKEN_ATTEMPTS || 6);
// After this many signed-in rounds, also try the device client instead of
// burning every remaining token attempt on a video the web clients reject.
const DEVICE_FALLBACK_AFTER_ROUND = 3;

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
    // Playback does not use this binding: media URLs need a PO token bound to
    // the video id. Keep the session visitor data around for metadata calls.
    const poBinding = session.session?.context?.client?.visitorData || undefined;
    return { session, poBinding, cookieFile };
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

async function getPoToken(contentBinding, { forceFresh = false, innertubeContext = null } = {}) {
  try {
    const response = await fetch(POT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content_binding: contentBinding,
        ...(forceFresh ? { bypass_cache: true } : {}),
        ...(innertubeContext ? { innertube_context: innertubeContext } : {})
      })
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

// The player API is called directly (instead of going through youtubei.js) so
// the request context and headers match a signed-in web session exactly: the
// account cookies plus the SAPISIDHASH authorization headers.
//
// Since 2026-11-16 a visitor minted by the homepage is rejected with
// `LOGIN_REQUIRED: Sign in to confirm you're not a bot`. Mirror yt-dlp instead:
// load the watch page (`has_verified=1`) with the bot cookies and reuse its
// VISITOR_DATA plus its player signature timestamp (STS) for every video.
const PLAYER_PAGE_USER_AGENT = process.env.YOUTUBE_BRIDGE_PAGE_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

const playerSessionCache = new Map();

async function fetchPlayerSessionData(cookieFile, videoId) {
  const startedAt = performance.now();
  const cookie = await netscapeCookiesToHeader(cookieFile);
  const target = videoId
    ? `https://www.youtube.com/watch?v=${videoId}&bpctr=9999999999&has_verified=1`
    : 'https://www.youtube.com/';
  const response = await fetch(target, {
    headers: {
      'user-agent': PLAYER_PAGE_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-us,en;q=0.5',
      'sec-fetch-mode': 'navigate',
      ...(cookie ? { cookie } : {})
    },
    signal: AbortSignal.timeout(PLAYER_REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`player session page HTTP ${response.status}`);
  const html = await response.text();
  const visitorData = extractVisitorData(html);
  if (!visitorData) throw new Error('visitor data missing from YouTube watch page');
  const signatureTimestamp = extractSignatureTimestamp(html);
  const userSessionId = extractUserSessionId(html);
  const sessionIndex = extractSessionIndex(html);
  const loggedIn = isLoggedInPage(html);
  console.log(`[youtube-bridge] player session refreshed elapsed_ms=${Math.round(performance.now() - startedAt)} sts=${signatureTimestamp} logged_in=${loggedIn} user_session=${Boolean(userSessionId)} session_index=${sessionIndex}`);
  return { visitorData, signatureTimestamp, userSessionId, sessionIndex, loggedIn, cookieHeader: cookie };
}

async function getPlayerSessionData(cookieFile, videoId, { forceFresh = false } = {}) {
  const key = cookieFileKey(cookieFile);
  const now = Date.now();
  const cached = playerSessionCache.get(key);
  if (!forceFresh && cached?.value && cached.expiresAt > now) return cached.value;
  if (!forceFresh && cached?.promise) return cached.promise;

  const promise = fetchPlayerSessionData(cookieFile, videoId)
    .then((value) => {
      playerSessionCache.set(key, { value, expiresAt: Date.now() + PLAYER_VISITOR_TTL_MS, promise: null });
      return value;
    })
    .catch((error) => {
      playerSessionCache.set(key, { value: null, expiresAt: 0, promise: null });
      throw error;
    });
  playerSessionCache.set(key, { value: null, expiresAt: 0, promise });
  while (playerSessionCache.size > SESSION_CACHE_MAX_ENTRIES) {
    playerSessionCache.delete(playerSessionCache.keys().next().value);
  }
  return promise;
}

async function requestPlayerJson(videoId, client, sessionData) {
  // Every remaining client is a logged-in one and carries the account session.
  // Device clients (`sendAuth: false`) take the cookies but reject SAPISIDHASH.
  const auth = client.sendCookies
    ? {
      cookie: sessionData?.cookieHeader || '',
      ...(client.sendAuth === false ? {} : {
        authorization: buildSapisidAuthorization(sessionData?.cookieHeader, sessionData?.userSessionId),
        sessionIndex: sessionData?.sessionIndex ?? 0,
        loggedIn: Boolean(sessionData?.loggedIn)
      })
    }
    : {};
  const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: playerRequestHeaders(client, sessionData?.visitorData, auth),
    body: JSON.stringify(playerRequestBody(videoId, client, {
      signatureTimestamp: sessionData?.signatureTimestamp
    })),
    signal: AbortSignal.timeout(PLAYER_REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`player API HTTP ${response.status}`);
  return response.json();
}

// youtubei.js keeps a single shared player instance per session, so two
// concurrent resolves deciphering at the same time race on its internal state
// and can return corrupt URLs. Serialize just the decipher step behind a simple
// promise chain; the network work around it stays parallel.
let decipherQueue = Promise.resolve();
function withPlayerDecipher(task) {
  const run = decipherQueue.then(task, task);
  decipherQueue = run.then(() => undefined, () => undefined);
  return run;
}

// Logged-in resolution path.
//
// Every request is made with the bot account: the watch page is loaded with the
// bot cookies, and the primary player requests carry the cookie jar plus the
// SAPISIDHASH authorization derived from it (cookies alone still answer
// LOGIN_REQUIRED). Their media URLs only play past the first MiB when a GVS PO
// token bound to the video id is appended as `pot`. There is no anonymous
// client: even the device fallback sends the account cookies.
//
// Latency work:
//  * the first PO token is minted while the player requests are in flight (the
//    binding is the video id, so it does not depend on them);
//  * another token is always minted in the background, so a rejected token does
//    not wait for a fresh BotGuard round trip;
//  * both signed-in clients are queried at once and validated in parallel;
//  * the per-range validation probes run concurrently;
//  * the device fallback is only queried after the signed-in clients fail.
async function resolveWithLoggedInPlayer(videoId, formatOptions, { cookieFile = '', forceFresh = false } = {}) {
  if (!cookieFile) throw new Error('no YouTube cookie file for this bot');
  const startedAt = performance.now();

  let sessionData = await getPlayerSessionData(cookieFile, videoId, { forceFresh });
  if (!sessionData?.cookieHeader) throw new Error('YouTube cookies are missing');
  if (!sessionData?.loggedIn) throw new Error('YouTube cookies are not logged in');

  const context = await getSession(cookieFile);
  const failures = [];

  // First token: reuse the provider cache when it has one (instant), then mint
  // fresh ones. Two stay queued so every retry starts with a token in hand.
  const tokenQueue = [getPoToken(videoId).catch(() => undefined)];
  const refillTokens = () => {
    while (tokenQueue.length < 2) {
      tokenQueue.push(getPoToken(videoId, { forceFresh: true }).catch(() => undefined));
    }
  };
  const takeToken = async () => {
    refillTokens();
    while (tokenQueue.length) {
      const pending = tokenQueue.shift();
      refillTokens();
      const token = await pending;
      if (token) return token;
    }
    return '';
  };
  refillTokens();

  const fetchCandidates = async (clientKeys) => {
    const players = await Promise.all(clientKeys.map(async (clientKey) => {
      const client = PLAYER_CLIENTS[clientKey];
      const playerStartedAt = performance.now();
      try {
        const playerJson = await requestPlayerJson(videoId, client, sessionData);
        const status = playerJson?.playabilityStatus?.status || 'UNKNOWN';
        console.log(`[youtube-bridge-timing] video=${videoId} client=${client.name} mode=logged-in stage=player elapsed_ms=${Math.round(performance.now() - playerStartedAt)} status=${status}`);
        if (status !== 'OK' || !playerJson?.streamingData) {
          const reason = playerJson?.playabilityStatus?.reason || '';
          failures.push(`${client.name}: ${reason || status}`);
          return null;
        }
        return { client, playerJson };
      } catch (error) {
        failures.push(`${client.name}: ${error?.message || String(error)}`);
        return null;
      }
    }));

    const found = [];
    // Decipher one after the other: youtubei.js keeps a single shared player
    // instance, so concurrent deciphers would fight over its state.
    for (const entry of players) {
      if (!entry) continue;
      const { client, playerJson } = entry;
      try {
        const format = formatOptions?.type === 'video'
          ? pickBestVideoFromPlayerJson(playerJson, { mimeIncludes: formatOptions.format, allowCiphered: true })
          : pickBestAudioFromPlayerJson(playerJson, { mimeIncludes: formatOptions.format, allowCiphered: true });
        if (!format) throw new Error('no playable format returned');
        let baseUrl = '';
        if (format.signature_cipher) {
          const player = context?.session?.session?.player;
          if (!player) throw new Error('YouTube player is unavailable');
          baseUrl = await withPlayerDecipher(async () => {
            player.po_token = undefined;
            return player.decipher(undefined, format.signature_cipher, undefined, new Map());
          });
        } else {
          baseUrl = format.url || '';
        }
        if (!baseUrl) throw new Error('decipher returned an empty stream URL');
        found.push({ client, playerJson, format, baseUrl });
      } catch (error) {
        failures.push(`${client.name}: ${error?.message || String(error)}`);
      }
    }
    return found;
  };

  let candidates = await fetchCandidates(LOGGED_IN_CLIENTS);
  if (!candidates.length && /LOGIN_REQUIRED|UNPLAYABLE/i.test(failures.join(' '))) {
    // A cached visitor/session can go stale; one refresh fixes it.
    sessionData = await getPlayerSessionData(cookieFile, videoId, { forceFresh: true });
    candidates = await fetchCandidates(LOGGED_IN_CLIENTS);
  }

  const isLiveFor = (list) => list.some(({ playerJson }) => (
    playerJson?.videoDetails?.isLive || playerJson?.videoDetails?.isLiveContent
  ));

  // Device fallback: the web clients above cannot serve every video (long HDR
  // test clips are the usual case). A device client still carries the account
  // cookies, returns direct googlevideo URLs and needs no PO token. It runs
  // after a few signed-in rounds (and at the end if those never got there), so a
  // normal video never pays for it.
  let deviceAttempted = false;
  async function tryDeviceFallback() {
    deviceAttempted = true;
    let deviceCandidates = await fetchCandidates(DEVICE_FALLBACK_CLIENTS);
    for (let attempt = 1; attempt <= 2 && deviceCandidates.length; attempt++) {
      const results = await Promise.all(deviceCandidates.map(async (candidate) => {
        try {
          const streamUrl = candidate.client.needsPoToken === false
            ? candidate.baseUrl
            : appendPoToken(candidate.baseUrl, await takeToken());
          const validatedLength = await validateStreamUrl(
            streamUrl,
            { 'User-Agent': candidate.client.userAgent },
            candidate.format.content_length,
            { isLive: isLiveFor(deviceCandidates) }
          );
          return { candidate, streamUrl, validatedLength };
        } catch (error) {
          return { candidate, error };
        }
      }));

      const winner = results.find((result) => !result.error);
      if (winner) {
        const { candidate } = winner;
        if (winner.validatedLength) candidate.format.content_length = winner.validatedLength;
        candidate.format.url = winner.streamUrl;
        console.log(`[youtube-bridge] resolved ${videoId} with client=${candidate.client.name} mode=device-fallback itag=${candidate.format.itag} attempt=${attempt} elapsed_ms=${Math.round(performance.now() - startedAt)}`);
        return {
          info: playerInfo(candidate.playerJson, videoId),
          format: candidate.format,
          client: candidate.client.name,
          userAgent: candidate.client.userAgent
        };
      }

      for (const { candidate, error } of results) {
        const message = error?.message || String(error);
        failures.push(`device:${candidate.client.name}#${attempt}: ${message}`);
        console.warn(`[youtube-bridge] ${videoId} client=${candidate.client.name} mode=device-fallback attempt=${attempt} failed: ${message}`);
      }

      // A fresh player response may land on a different googlevideo host.
      deviceCandidates = await fetchCandidates(DEVICE_FALLBACK_CLIENTS);
    }
    return null;
  }

  for (let round = 1; round <= LOGGED_IN_TOKEN_ATTEMPTS && candidates.length; round++) {
    const roundStartedAt = performance.now();
    const poToken = await takeToken();
    // No token means the provider is unavailable, but the device fallback below
    // does not need one, so keep going instead of failing here.
    if (!poToken) {
      failures.push('POT provider returned no token');
      break;
    }

    const results = await Promise.all(candidates.map(async (candidate) => {
      try {
        const streamUrl = appendPoToken(candidate.baseUrl, poToken);
        const validatedLength = await validateStreamUrl(
          streamUrl,
          { 'User-Agent': candidate.client.userAgent },
          candidate.format.content_length,
          { isLive: isLiveFor(candidates) }
        );
        return { candidate, streamUrl, validatedLength };
      } catch (error) {
        return { candidate, error };
      }
    }));

    console.log(`[youtube-bridge-timing] video=${videoId} mode=logged-in stage=validate elapsed_ms=${Math.round(performance.now() - roundStartedAt)} round=${round} pot_len=${poToken.length} clients=${candidates.map(({ client }) => client.name).join('+')}`);

    const winner = results.find((result) => !result.error);
    if (winner) {
      const { candidate } = winner;
      if (winner.validatedLength) candidate.format.content_length = winner.validatedLength;
      candidate.format.url = winner.streamUrl;
      console.log(`[youtube-bridge] resolved ${videoId} with client=${candidate.client.name} mode=logged-in itag=${candidate.format.itag} pot_len=${poToken.length} round=${round} elapsed_ms=${Math.round(performance.now() - startedAt)}`);
      return {
        info: playerInfo(candidate.playerJson, videoId),
        format: candidate.format,
        client: candidate.client.name,
        userAgent: candidate.client.userAgent
      };
    }

    for (const { candidate, error } of results) {
      const message = error?.message || String(error);
      failures.push(`logged-in:${candidate.client.name}#${round}: ${message}`);
      console.warn(`[youtube-bridge] ${videoId} client=${candidate.client.name} mode=logged-in round=${round}/${LOGGED_IN_TOKEN_ATTEMPTS} failed: ${message}`);
    }
    // Never drop a client just because `bytes=0-0` was rejected: an invalid PO
    // token also rejects the first byte, and the provider hands out a bad token
    // often enough that two in a row are common. The rounds below mint a fresh
    // token each time, so a client that truly cannot serve the video simply
    // keeps failing while a working one wins the round.
    if (round >= DEVICE_FALLBACK_AFTER_ROUND && !deviceAttempted) {
      const fallback = await tryDeviceFallback();
      if (fallback) return fallback;
    }
  }

  if (!deviceAttempted) {
    const fallback = await tryDeviceFallback();
    if (fallback) return fallback;
  }

  throw new Error(failures.join(' | '));
}

async function resolveFormat(context, videoId, formatOptions, options = {}) {
  const cookieFile = context?.cookieFile || '';
  if (!cookieFile) {
    throw new Error(`Unable to resolve stream for ${videoId}; this bot has no YouTube cookie file`);
  }
  return resolveWithLoggedInPlayer(videoId, formatOptions, { ...options, cookieFile });
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

  const resolution = resolveTrackUncached(body, videoId)
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

async function resolveTrackUncached(body, videoId) {
  const context = await getSession(body.cookie_file);

  const { info, format, client, userAgent } = await resolveFormat(context, videoId, {
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
    http_headers: { 'User-Agent': userAgent || USER_AGENT }
  };
}

async function getInfo(body) {
  const videoId = body.video_id || extractVideoId(body.url);
  if (!videoId) throw new Error('Invalid YouTube URL or video ID');

  // Metadata needs the same logged-in player request as playback: the plain
  // cookie-only Innertube call answers `LOGIN_REQUIRED` for everybody now.
  if (body.cookie_file) {
    try {
      const sessionData = await getPlayerSessionData(body.cookie_file, videoId);
      if (sessionData?.cookieHeader && sessionData?.loggedIn) {
        const playerJson = await requestPlayerJson(videoId, PLAYER_CLIENTS.mweb, sessionData);
        const info = playerInfo(playerJson, videoId);
        return {
          ...infoPayload(info, videoId),
          playability_status: playerJson?.playabilityStatus?.status || '',
          playability_reason: playerJson?.playabilityStatus?.reason || ''
        };
      }
    } catch (error) {
      console.warn(`[youtube-bridge] logged-in info failed for ${videoId}: ${error.message}`);
    }
  }

  const context = await getSession(body.cookie_file);
  const client = body.client === 'YTMUSIC' ? 'YTMUSIC' : 'MWEB';
  const poToken = await getPoToken(videoId);
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

async function searchVideos(body, req) {
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
      const streamContext = {
        videoId: topVideoId,
        client: requestedClient,
        botId: body.bot_id,
        cookieFile: body.cookie_file
      };
      const cacheKey = `${cookieFileKey(body.cookie_file)}:${requestedClient}:${topVideoId}`;
      const cached = resolveCache.get(cacheKey);
      if (cached && cached.url) {
        results[0] = {
          ...results[0],
          ...cached,
          stream_url: proxiedStreamUrl(req, cached, streamContext)
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
              stream_url: proxiedStreamUrl(req, resolved, streamContext)
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

  if (!body.video) {
    const { format: audio, client, userAgent } = await resolveFormat(context, videoId, {
      type: 'audio', quality: 'best', format: 'any'
    });
    return {
      audio: formatPayload(audio),
      client,
      http_headers: { 'User-Agent': userAgent || USER_AGENT }
    };
  }

  // The video and audio tracks are independent, so resolve (and validate) them
  // at the same time instead of paying both latencies back to back.
  const resolveVideo = async () => {
    try {
      return await resolveFormat(context, videoId, { type: 'video', quality: 'best', format: 'mp4' });
    } catch {
      return resolveFormat(context, videoId, { type: 'video', quality: 'best', format: 'any' });
    }
  };
  const resolveAudio = async () => {
    try {
      // Prefer the highest-bitrate audio (normally Opus) instead of forcing AAC.
      return await resolveFormat(context, videoId, { type: 'audio', quality: 'best', format: 'any' });
    } catch {
      return resolveFormat(context, videoId, { type: 'audio', quality: 'best', format: 'mp4' });
    }
  };
  const [videoResult, audioResult] = await Promise.all([resolveVideo(), resolveAudio()]);

  return {
    video: formatPayload(videoResult.format),
    audio: formatPayload(audioResult.format),
    client: `${videoResult.client}/${audioResult.client}`,
    http_headers: { 'User-Agent': videoResult.userAgent || audioResult.userAgent || USER_AGENT }
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
// Read a full chunk when validating: YouTube sometimes hands out URLs that
// serve the first ~1 MiB and then 403 on every later range. A 64 KiB probe
// passes those URLs, a full 1 MiB probe rejects them.
const STREAM_VALIDATION_PROBE_BYTES = STREAM_CHUNK_SIZE;
const STREAM_VALIDATION_TIMEOUT_MS = 10000;
const STREAM_REFRESH_MAX_ATTEMPTS = 2;
const STREAM_TTL_MS = 6 * 60 * 60 * 1000;
const STREAM_REGISTRY_MAX = 4096;
const streamRegistry = new Map();
let streamSequence = 0;

function registerStreamDescriptor(payload, context = {}) {
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
    videoId: context.videoId || payload.videoId || payload.video_id || payload.id || '',
    requestedClient: context.client || payload.client || '',
    botId: context.botId || '',
    cookieFile: context.cookieFile || '',
    refreshCount: 0,
    refreshPromise: null,
    expiresAt: now + STREAM_TTL_MS
  });
  return id;
}

function proxiedStreamUrl(req, payload, context = {}) {
  const host = req?.headers?.host || `${HOST}:${PORT}`;
  return `http://${host}/stream/${registerStreamDescriptor(payload, context)}`;
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

function fetchUpstreamRange(descriptor, start, end, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const request = https.request(new URL(descriptor.url), {
      method: 'GET',
      headers: upstreamRequestHeaders(descriptor, start, end)
    }, resolve);
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Upstream request timed out')));
    request.end();
  });
}

function discardUpstream(upstream) {
  if (!upstream) return;
  upstream.on('error', () => {});
  upstream.destroy();
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

async function validateStreamUrl(url, headers, contentLength, { isLive = false } = {}) {
  // Live streams do not have a stable content length / random-access window;
  // probing them can reject perfectly valid manifests, so leave them untouched.
  if (isLive) return 0;

  const descriptor = {
    url,
    headers: headers || {},
    contentLength: Number(contentLength) || 0
  };
  if (!descriptor.contentLength) {
    descriptor.contentLength = await probeUpstreamContentLength(descriptor);
  }

  const ranges = !descriptor.contentLength
    ? [[0, 0]]
    : validationProbeRanges(descriptor.contentLength, STREAM_CHUNK_SIZE, STREAM_VALIDATION_PROBE_BYTES);

  // Probe every range at once: the first byte and the second chunk are
  // independent requests, so waiting for them sequentially doubled the
  // validation latency for no benefit.
  await Promise.all(ranges.map(async ([start, end]) => {
    const upstream = await fetchUpstreamRange(descriptor, start, end, STREAM_VALIDATION_TIMEOUT_MS);
    const status = upstream.statusCode || 0;
    discardUpstream(upstream);
    if (status !== 206 && !(status === 200 && start === 0)) {
      const error = new Error(`stream validation failed (HTTP ${status}) for bytes ${start}-${end}`);
      error.code = 'STREAM_VALIDATION_FAILED';
      throw error;
    }
    return true;
  }));
  return descriptor.contentLength;
}

async function refreshStreamDescriptor(descriptor) {
  if (!descriptor?.videoId) return false;
  if (descriptor.refreshCount >= STREAM_REFRESH_MAX_ATTEMPTS) return false;
  if (descriptor.refreshPromise) return descriptor.refreshPromise;

  descriptor.refreshCount += 1;
  descriptor.refreshPromise = (async () => {
    const requestedClient = descriptor.requestedClient === 'YTMUSIC' ? 'YTMUSIC' : 'MWEB';
    try {
      const context = await getSession(descriptor.cookieFile);
      const { info, format, client, userAgent } = await resolveFormat(context, descriptor.videoId, {
        type: 'audio',
        quality: 'best',
        format: 'any'
      }, { forceFresh: descriptor.refreshCount > 1 });

      const nextLength = Number(format.content_length) || 0;
      if (descriptor.contentLength && nextLength && nextLength !== descriptor.contentLength) {
        throw new Error(`content length changed (${descriptor.contentLength} -> ${nextLength})`);
      }

      const payload = {
        ...infoPayload(info, descriptor.videoId),
        ...formatPayload(format),
        client,
        http_headers: { 'User-Agent': userAgent || USER_AGENT }
      };
      const ttlMs = streamCacheTtlMs(format.url);

      descriptor.url = format.url;
      descriptor.headers = payload.http_headers;
      descriptor.contentLength = nextLength || descriptor.contentLength;
      descriptor.expiresAt = Date.now() + ttlMs;

      const cacheKey = `${cookieFileKey(descriptor.cookieFile)}:${requestedClient}:${descriptor.videoId}`;
      resolveCache.set(cacheKey, { ...payload, cache_expires_at_ms: Date.now() + ttlMs }, ttlMs);
      scheduleSaveDiskCache();
      console.log(`[youtube-bridge] stream refreshed video=${descriptor.videoId} client=${client} itag=${format.itag} attempt=${descriptor.refreshCount}`);
      return true;
    } catch (error) {
      console.warn(`[youtube-bridge] stream refresh failed video=${descriptor.videoId} attempt=${descriptor.refreshCount}: ${error.message}`);
      return false;
    } finally {
      descriptor.refreshPromise = null;
    }
  })();
  return descriptor.refreshPromise;
}

async function fetchChunkWithRefresh(descriptor, start, end) {
  let refreshed = false;
  while (true) {
    let upstream;
    try {
      upstream = await fetchUpstreamRange(descriptor, start, end);
    } catch (error) {
      if (!refreshed && await refreshStreamDescriptor(descriptor)) {
        refreshed = true;
        continue;
      }
      throw error;
    }

    const status = upstream.statusCode || 0;
    if (status === 206 && start > 0) {
      const contentRange = upstream.headers['content-range'] || '';
      const match = /^bytes\s+(\d+)-/.exec(contentRange);
      if (match && Number(match[1]) !== start) {
        discardUpstream(upstream);
        if (!refreshed && await refreshStreamDescriptor(descriptor)) {
          refreshed = true;
          continue;
        }
        throw new Error(`Upstream returned wrong range start (${match[1]} != ${start})`);
      }
    }
    if (status === 206 || (status === 200 && start === 0)) return upstream;

    discardUpstream(upstream);
    if (!refreshed && await refreshStreamDescriptor(descriptor)) {
      refreshed = true;
      continue;
    }
    throw new Error(`Upstream responded HTTP ${status}`);
  }
}

async function pipeUpstreamChunks(descriptor, res, start, end) {
  let position = start;
  while (position <= end && !res.destroyed) {
    const chunkEnd = Math.min(position + STREAM_CHUNK_SIZE - 1, end);
    const upstream = await fetchChunkWithRefresh(descriptor, position, chunkEnd);
    const status = upstream.statusCode || 0;
    if (status === 200 && position > 0) {
      discardUpstream(upstream);
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
    // mpv/ffmpeg seek and close connections all the time; that aborts the
    // upstream request and is normal playback behaviour, not a failure.
    const clientGone = res.destroyed
      || ['ECONNRESET', 'EPIPE', 'ABORT_ERR'].includes(error?.code)
      || /aborted|reset by peer|broken pipe/i.test(error?.message || '');
    if (!clientGone) console.warn(`[youtube-bridge] stream ${id} failed: ${error.message}`);
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
      if (payload.url) {
        payload.url = proxiedStreamUrl(req, payload, {
          videoId: payload.videoId || payload.id || body.video_id,
          client: body.client,
          botId: body.bot_id,
          cookieFile: body.cookie_file
        });
      }
      return json(res, 200, payload);
    }
    if (req.url === '/invalidate') return json(res, 200, invalidateResolution(body));
    if (req.url === '/info') return json(res, 200, await getInfo(body));
    if (req.url === '/playlist') return json(res, 200, await getPlaylist(body));
    if (req.url === '/search') return json(res, 200, await searchVideos(body, req));
    if (req.url === '/recommendations') return json(res, 200, await getMusicRecommendations(body));
    if (req.url === '/download-plan') {
      const plan = await getDownloadPlan(body);
      const videoId = body.video_id || extractVideoId(body.url);
      for (const key of ['audio', 'video']) {
        const entry = plan?.[key];
        if (entry?.url) {
          entry.url = proxiedStreamUrl(req, { ...entry, http_headers: plan.http_headers }, {
            videoId,
            client: body.client,
            botId: body.bot_id,
            cookieFile: body.cookie_file
          });
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
