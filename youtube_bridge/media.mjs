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

// Player clients whose response contains direct googlevideo URLs WITHOUT the
// `n`/`pot` query parameters. Those parameters are exactly what makes YouTube
// answer 403 for every range past the first MiB, so the bridge resolves streams
// with this client instead of the web/MWEB ones. The values mirror what yt-dlp
// uses: a clean client-only context (no browser/config noise) plus the visitor
// data sent as the `X-Goog-Visitor-Id` header.
//
// VISIONOS is the only tested client that survives the full range probe. Others
// that also answer without `n` (ANDROID_VR, TV_SAMSUNG) still return 403 past
// ~1 MiB from this host, so they are intentionally not used.
export const PLAYER_CLIENTS = {
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
    }
  }
};

export function extractVisitorData(html) {
  const match = /"VISITOR_DATA"\s*:\s*"([^"]+)"/.exec(String(html || ''));
  return match ? match[1] : '';
}

export function playerRequestBody(videoId, client) {
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
    playbackContext: {
      contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' }
    },
    contentCheckOk: true,
    racyCheckOk: true
  };
}

export function playerRequestHeaders(client, visitorData) {
  const headers = {
    'content-type': 'application/json',
    'x-youtube-client-name': client.clientId,
    'x-youtube-client-version': client.version,
    origin: 'https://www.youtube.com',
    'user-agent': client.userAgent
  };
  if (visitorData) headers['x-goog-visitor-id'] = visitorData;
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

export function pickBestAudioFromPlayerJson(playerJson, { mimeIncludes = '' } = {}) {
  const candidates = playerFormats(playerJson).filter((format) => format.has_audio && !format.has_video && format.url);
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

export function pickBestVideoFromPlayerJson(playerJson, { mimeIncludes = '' } = {}) {
  const all = playerFormats(playerJson).filter((format) => format.has_video && format.url);
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
