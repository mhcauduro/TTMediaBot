import { createHash } from 'node:crypto';

const STREAM_CACHE_FALLBACK_TTL_MS = 5 * 60 * 1000;
const STREAM_CACHE_MAX_TTL_MS = 60 * 60 * 1000;
const STREAM_EXPIRY_SAFETY_MS = 2 * 60 * 1000;

function text(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  if (typeof value.toString === 'function') return value.toString();
  return '';
}

export function normalizeSearchKey(mode, query) {
  const normalized = String(query || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  return `${mode}:${normalized}`;
}

export function musicItemPayload(item) {
  const id = item?.id || item?.video_id || item?.videoId || '';
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  const artists = Array.isArray(item.artists)
    ? item.artists
      .map((artist) => ({ name: text(artist?.name) }))
      .filter((artist) => artist.name)
    : [];
  const uploader = artists.map((artist) => artist.name).join(', ') || text(item.author);

  return {
    id,
    videoId: id,
    title: text(item.title),
    uploader,
    artists,
    duration: Number(item?.duration?.seconds || item?.duration_seconds || 0),
    webpage_url: `https://www.youtube.com/watch?v=${id}`
  };
}

export function streamCacheTtlMs(streamUrl, nowMs = Date.now()) {
  try {
    const expiresAtSeconds = Number(new URL(streamUrl).searchParams.get('expire'));
    if (!Number.isFinite(expiresAtSeconds) || expiresAtSeconds <= 0) {
      return STREAM_CACHE_FALLBACK_TTL_MS;
    }
    const safeTtl = expiresAtSeconds * 1000 - nowMs - STREAM_EXPIRY_SAFETY_MS;
    return Math.max(0, Math.min(safeTtl, STREAM_CACHE_MAX_TTL_MS));
  } catch {
    return STREAM_CACHE_FALLBACK_TTL_MS;
  }
}

// Higher bitrate always wins; Opus only breaks ties against another codec at
// the same bitrate. This makes "best audio" deterministic instead of relying
// on the container ordering/quality labels returned by YouTube.
export function audioFormatScore(format) {
  const bitrate = Number(format?.average_bitrate || format?.bitrate || 0);
  const opusBonus = /opus/i.test(String(format?.mime_type || '')) ? 1 : 0;
  return bitrate * 10 + opusBonus;
}

export function pickBestAudioFormat(info, { mimeIncludes = '' } = {}) {
  const formats = info?.streaming_data?.adaptive_formats || [];
  let candidates = formats.filter((format) => format?.has_audio && !format?.has_video);
  if (!candidates.length) return null;

  const wanted = String(mimeIncludes || '').toLowerCase();
  if (wanted && wanted !== 'any') {
    const matching = candidates.filter((format) => String(format?.mime_type || '').toLowerCase().includes(wanted));
    if (matching.length) candidates = matching;
  }

  return candidates.reduce((best, format) => (
    audioFormatScore(format) > audioFormatScore(best) ? format : best
  ));
}

// Validate more than the first byte: a broken googlevideo URL happily answers
// `bytes=0-0` and still rejects every range past the first MiB. Probe the start
// and the beginning of the second chunk. Later chunks are protected by the
// mid-stream refresh, so probing the middle would reject otherwise usable URLs.
export function validationProbeRanges(contentLength, chunkSize, probeBytes) {
  const total = Number(contentLength) || 0;
  const chunk = Math.max(1, Number(chunkSize) || 1);
  const probe = Math.max(1, Number(probeBytes) || 1);
  if (total <= 1) return [[0, 0]];

  const last = total - 1;
  const secondChunkStart = Math.min(chunk, last);
  return [
    [0, 0],
    [secondChunkStart, Math.min(secondChunkStart + probe - 1, last)]
  ];
}

// Player clients used for playback.
//
// VISIONOS is the primary, cookie-only client: a single request with the bot
// cookie jar returns direct googlevideo URLs that need no decipher and no PO
// token (`needsPoToken: false`). YouTube refuses SAPISIDHASH on device clients
// (`sendAuth: false`), so this path keeps working even with an expired account
// session. The test matrix showed it answers every regular video measured,
// including 16K/HDR uploads.
//
// MWEB/WEB_CREATOR are the account clients, used only when the device client
// refuses a video. They are called with the cookies plus the SAPISIDHASH
// authorization headers (see buildSapisidAuthorization). They reply with
// `signatureCipher` formats that must be deciphered, and the media URL only
// serves ranges past the first MiB when a GVS PO token bound to the *video id*
// is appended as `pot`.
export const PLAYER_CLIENTS = {
  mweb: {
    name: 'MWEB',
    clientId: '2',
    version: '2.20260708.05.00',
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)',
    context: {
      clientName: 'MWEB',
      clientVersion: '2.20260708.05.00'
    },
    sendCookies: true
  },
  // Fallback for videos whose MWEB stream URLs reject every request with 403
  // (mostly official music videos). WEB_CREATOR serves the same ciphered
  // formats but from a host that accepts the first byte, so the PO token only
  // gates the ranges past the first MiB.
  web_creator: {
    name: 'WEB_CREATOR',
    clientId: '62',
    version: '1.20260708.06.00',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    context: {
      clientName: 'WEB_CREATOR',
      clientVersion: '1.20260708.06.00'
    },
    sendCookies: true
  },
  // Cookie-only device client: first in line, because it needs neither the
  // account authorization nor a PO token.
  visionos: {
    name: 'VISIONOS',
    clientId: '101',
    version: '1.02',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    context: {
      clientName: 'VISIONOS',
      clientVersion: '1.02',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      osName: 'visionOS',
      osVersion: '26.5.23O471'
    },
    sendCookies: true,
    sendAuth: false,
    needsPoToken: false
  }
};

// Order matters: MWEB answers for most videos and is preferred, WEB_CREATOR is
// the fallback for the ones MWEB cannot serve. Both are account clients.
export const LOGGED_IN_CLIENTS = ['mweb', 'web_creator'];

// Cookie-only device clients, tried before the account path.
export const DEVICE_CLIENTS = ['visionos'];

export function extractVisitorData(html) {
  const match = /"VISITOR_DATA"\s*:\s*"([^"]+)"/.exec(String(html || ''));
  return match ? match[1] : '';
}

// `STS` is the YouTube player signature timestamp. yt-dlp sends it inside
// `playbackContext.contentPlaybackContext` for every player request; the player
// API accepts requests without it, but sending it keeps us identical to yt-dlp.
export function extractSignatureTimestamp(html) {
  const match = /"STS"\s*:\s*(\d+)/.exec(String(html || ''));
  return match ? Number(match[1]) : 0;
}

// `DATASYNC_ID` is a `"<channel>||<session>"` pair. The session half is the
// account session id used by the SAPISIDHASH authorization scheme.
export function extractUserSessionId(html) {
  const page = String(html || '');
  const direct = /"USER_SESSION_ID"\s*:\s*"([^"]+)"/.exec(page);
  if (direct) return direct[1];
  const dataSync = /"DATASYNC_ID"\s*:\s*"([^"]+)"/.exec(page);
  if (!dataSync) return '';
  const parts = dataSync[1].split('||');
  return parts.length > 1 ? parts[1] : '';
}

export function extractSessionIndex(html) {
  const match = /"SESSION_INDEX"\s*:\s*"?(\d+)"?/.exec(String(html || ''));
  return match ? Number(match[1]) : 0;
}

export function isLoggedInPage(html) {
  return /"LOGGED_IN"\s*:\s*true/.test(String(html || ''));
}

export function cookieHeaderToMap(cookieHeader) {
  const map = new Map();
  for (const part of String(cookieHeader || '').split(/;\s*/)) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    map.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return map;
}

// SAPISIDHASH is what turns a cookie jar into a genuinely authenticated
// YouTube session (the same scheme google APIs use). Without it the player API
// keeps answering `LOGIN_REQUIRED` even when the cookies themselves are valid.
export function buildSapisidAuthorization(cookieHeader, userSessionId, {
  origin = 'https://www.youtube.com',
  nowSeconds = Math.floor(Date.now() / 1000)
} = {}) {
  const cookies = cookieHeaderToMap(cookieHeader);
  const schemes = [
    ['SAPISIDHASH', cookies.get('SAPISID') || cookies.get('__Secure-3PAPISID')],
    ['SAPISID1PHASH', cookies.get('__Secure-1PAPISID')],
    ['SAPISID3PHASH', cookies.get('__Secure-3PAPISID')]
  ];
  const authorization = [];
  for (const [scheme, sapisid] of schemes) {
    if (!sapisid) continue;
    const parts = [];
    if (userSessionId) parts.push(userSessionId);
    parts.push(String(nowSeconds), sapisid, origin);
    const hash = createHash('sha1').update(parts.join(' ')).digest('hex');
    authorization.push(`${scheme} ${nowSeconds}_${hash}${userSessionId ? '_u' : ''}`);
  }
  return authorization.join(' ');
}

// A GVS PO token must be appended to the media URL. Upstream only serves
// ranges past the first MiB when the `pot` parameter is present and valid.
export function appendPoToken(streamUrl, token) {
  if (!streamUrl || !token) return streamUrl;
  try {
    const url = new URL(streamUrl);
    url.searchParams.set('pot', token);
    return url.toString();
  } catch {
    return streamUrl;
  }
}

export function playerRequestBody(videoId, client, { signatureTimestamp = 0 } = {}) {
  const contentPlaybackContext = { html5Preference: 'HTML5_PREF_WANTS' };
  if (signatureTimestamp) contentPlaybackContext.signatureTimestamp = signatureTimestamp;
  return {
    context: {
      client: {
        ...client.context,
        hl: 'en',
        timeZone: 'UTC',
        utcOffsetMinutes: 0,
        userAgent: client.userAgent
      }
    },
    videoId,
    playbackContext: { contentPlaybackContext },
    contentCheckOk: true,
    racyCheckOk: true
  };
}

export function playerRequestHeaders(client, visitorData, {
  cookie = '',
  authorization = '',
  sessionIndex = 0,
  loggedIn = false
} = {}) {
  const headers = {
    'content-type': 'application/json',
    'x-youtube-client-name': client.clientId,
    'x-youtube-client-version': client.version,
    origin: 'https://www.youtube.com',
    'user-agent': client.userAgent,
    // yt-dlp sends its normal navigation headers on API calls too. YouTube uses
    // them as part of the bot check, so keep the player request indistinguishable
    // from a page-driven request.
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-us,en;q=0.5',
    'sec-fetch-mode': 'navigate'
  };
  if (visitorData) headers['x-goog-visitor-id'] = visitorData;
  if (cookie) headers.cookie = cookie;
  if (authorization) {
    headers.authorization = authorization;
    headers['x-origin'] = 'https://www.youtube.com';
    headers['x-goog-authuser'] = String(sessionIndex ?? 0);
    if (loggedIn) headers['x-youtube-bootstrap-logged-in'] = 'true';
  }
  return headers;
}

function numeric(value) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

// The player API answers JSON in camelCase, while the rest of the bridge uses
// the snake_case shape produced by youtubei.js. Normalize once here.
export function formatFromPlayerJson(raw) {
  const mimeType = String(raw?.mimeType || raw?.mime_type || '');
  const isAudioMime = /^audio\//i.test(mimeType);
  const isVideoMime = /^video\//i.test(mimeType);
  const hasAudioTrack = isAudioMime || Boolean(raw?.audioQuality || raw?.audioChannels || raw?.audioSampleRate);
  let contentLength = Number(raw?.contentLength) || 0;
  const streamUrl = raw?.url || '';
  if (!contentLength && streamUrl) {
    contentLength = Number(new URL(streamUrl).searchParams.get('clen')) || 0;
  }
  return {
    url: streamUrl,
    itag: Number(raw?.itag) || 0,
    mime_type: mimeType,
    bitrate: Number(raw?.bitrate) || 0,
    average_bitrate: Number(raw?.averageBitrate || raw?.bitrate) || 0,
    content_length: contentLength,
    quality: String(raw?.quality || ''),
    quality_label: String(raw?.qualityLabel || ''),
    audio_quality: String(raw?.audioQuality || ''),
    audio_sample_rate: numeric(raw?.audioSampleRate),
    audio_channels: Number(raw?.audioChannels) || 0,
    width: Number(raw?.width) || 0,
    height: Number(raw?.height) || 0,
    fps: Number(raw?.fps) || 0,
    signature_cipher: String(raw?.signatureCipher || raw?.cipher || ''),
    has_audio: hasAudioTrack,
    has_video: isVideoMime
  };
}

export function playerFormats(playerJson) {
  const streaming = playerJson?.streamingData || playerJson?.streaming_data || {};
  const adaptive = streaming.adaptiveFormats || streaming.adaptive_formats || [];
  const progressive = streaming.formats || [];
  return [...adaptive, ...progressive].map(formatFromPlayerJson);
}

export function pickBestAudioFromPlayerJson(playerJson, { mimeIncludes = '', allowCiphered = false } = {}) {
  const candidates = playerFormats(playerJson)
    .filter((format) => format.has_audio && !format.has_video)
    .filter((format) => format.url || (allowCiphered && format.signature_cipher));
  if (!candidates.length) return null;

  const wanted = String(mimeIncludes || '').toLowerCase();
  let pool = candidates;
  if (wanted && wanted !== 'any') {
    const matching = candidates.filter((format) => format.mime_type.toLowerCase().includes(wanted));
    if (matching.length) pool = matching;
  }
  return pool.reduce((best, format) => (
    audioFormatScore(format) > audioFormatScore(best) ? format : best
  ));
}

export function videoFormatScore(format) {
  const height = Number(format?.height) || 0;
  const bitrate = Number(format?.bitrate) || 0;
  const mp4Bonus = /mp4/i.test(String(format?.mime_type || '')) ? 1 : 0;
  return height * 1e9 + bitrate * 1e3 + mp4Bonus;
}

export function pickBestVideoFromPlayerJson(playerJson, { mimeIncludes = '', allowCiphered = false } = {}) {
  const all = playerFormats(playerJson)
    .filter((format) => format.has_video)
    .filter((format) => format.url || (allowCiphered && format.signature_cipher));
  if (!all.length) return null;
  // Keep video-only formats so the caller can mux them with the best audio.
  const videoOnly = all.filter((format) => !format.has_audio);
  let candidates = videoOnly.length ? videoOnly : all;

  const wanted = String(mimeIncludes || '').toLowerCase();
  if (wanted && wanted !== 'any') {
    const matching = candidates.filter((format) => format.mime_type.toLowerCase().includes(wanted));
    if (matching.length) candidates = matching;
  }
  return candidates.reduce((best, format) => (
    videoFormatScore(format) > videoFormatScore(best) ? format : best
  ));
}

export function playerInfo(playerJson, videoId) {
  const details = playerJson?.videoDetails || {};
  const author = String(details.author || '');
  return {
    basic_info: {
      id: String(details.videoId || videoId),
      title: String(details.title || ''),
      author,
      channel: author ? { name: author } : undefined,
      duration: Number(details.lengthSeconds) || 0,
      is_live: Boolean(details.isLive || details.isLiveContent),
      is_live_content: Boolean(details.isLiveContent)
    }
  };
}
