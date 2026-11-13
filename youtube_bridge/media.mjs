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

// yt-dlp is the bridge's primary resolver: it produces googlevideo URLs without
// the `n`/`pot` parameters that youtubei.js adds, and those parameters are what
// make YouTube reject every range past the first MiB.
export function ytDlpFormatSelector(formatOptions) {
  const type = formatOptions?.type === 'video' ? 'video' : 'audio';
  const wantsMp4 = String(formatOptions?.format || '').toLowerCase() === 'mp4';
  if (type === 'video') {
    return wantsMp4 ? 'bestvideo[ext=mp4]/bestvideo/best' : 'bestvideo/best';
  }
  // bestaudio is the highest-bitrate audio-only format available. The mp4
  // variant (m4a) is only requested when the caller explicitly asks for it.
  return wantsMp4 ? 'bestaudio[ext=m4a]/bestaudio/best' : 'bestaudio/best';
}

export function formatFromYtDlpUrl(streamUrl) {
  const parsed = new URL(streamUrl);
  const params = parsed.searchParams;
  const mimeType = decodeURIComponent(params.get('mime') || '');
  const isVideoOnly = /^video\//i.test(mimeType);
  return {
    url: streamUrl,
    itag: Number(params.get('itag')) || 0,
    mime_type: mimeType,
    bitrate: Number(params.get('bitrate')) || 0,
    average_bitrate: Number(params.get('bitrate')) || 0,
    content_length: Number(params.get('clen')) || 0,
    quality: '',
    quality_label: '',
    audio_quality: '',
    audio_sample_rate: 0,
    audio_channels: 0,
    has_audio: !isVideoOnly,
    has_video: isVideoOnly
  };
}
