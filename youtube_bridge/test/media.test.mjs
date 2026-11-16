import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLAYER_CLIENTS,
  extractSignatureTimestamp,
  extractVisitorData,
  formatFromPlayerJson,
  musicItemPayload,
  normalizeSearchKey,
  pickBestAudioFormat,
  pickBestAudioFromPlayerJson,
  pickBestVideoFromPlayerJson,
  playerInfo,
  playerRequestBody,
  playerRequestHeaders,
  streamCacheTtlMs,
  validationProbeRanges
} from '../media.mjs';

test('normalizes equivalent search queries per mode', () => {
  assert.equal(normalizeSearchKey('music', '  Ela   VEM  '), 'music:ela vem');
  assert.equal(normalizeSearchKey('video', 'Ela Vem'), 'video:ela vem');
});

test('maps YouTube Music search items to the bridge contract', () => {
  const payload = musicItemPayload({
    id: 'J0pZqX0ITxg',
    title: 'Ela Vem',
    artists: [{ name: 'Mc G15' }, { name: 'Mc Livinho' }],
    duration: { seconds: 197 }
  });

  assert.deepEqual(payload, {
    id: 'J0pZqX0ITxg',
    videoId: 'J0pZqX0ITxg',
    title: 'Ela Vem',
    uploader: 'Mc G15, Mc Livinho',
    artists: [{ name: 'Mc G15' }, { name: 'Mc Livinho' }],
    duration: 197,
    webpage_url: 'https://www.youtube.com/watch?v=J0pZqX0ITxg'
  });
});

test('maps Up Next items using their video_id and author', () => {
  const payload = musicItemPayload({
    video_id: '48Lrud3Bxpc',
    title: { toString: () => 'Ela Vem (SET DJ NENE)' },
    author: 'Mc Kevin',
    duration: { seconds: 288 }
  });

  assert.equal(payload.videoId, '48Lrud3Bxpc');
  assert.equal(payload.title, 'Ela Vem (SET DJ NENE)');
  assert.equal(payload.uploader, 'Mc Kevin');
});

test('derives stream cache TTL from URL expiry with safety margin and cap', () => {
  const nowMs = 1_800_000_000_000;
  const expiresAt = Math.floor(nowMs / 1000) + 1_800;
  const url = `https://example.test/audio?expire=${expiresAt}`;

  assert.equal(streamCacheTtlMs(url, nowMs), 1_680_000);
});

test('caps long stream validity and rejects already unsafe URLs', () => {
  const nowMs = 1_800_000_000_000;
  const farExpiry = Math.floor(nowMs / 1000) + 10_000;
  const nearExpiry = Math.floor(nowMs / 1000) + 60;

  assert.equal(streamCacheTtlMs(`https://x.test/?expire=${farExpiry}`, nowMs), 3_600_000);
  assert.equal(streamCacheTtlMs(`https://x.test/?expire=${nearExpiry}`, nowMs), 0);
  assert.equal(streamCacheTtlMs('https://x.test/no-expiry', nowMs), 300_000);
});

test('picks the highest-bitrate audio and prefers Opus on ties', () => {
  const formats = [
    { itag: 140, mime_type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 129000, average_bitrate: 128000, has_audio: true },
    { itag: 251, mime_type: 'audio/webm; codecs="opus"', bitrate: 160000, average_bitrate: 160000, has_audio: true },
    { itag: 250, mime_type: 'audio/webm; codecs="opus"', bitrate: 70000, average_bitrate: 70000, has_audio: true },
    { itag: 999, mime_type: 'audio/webm; codecs="opus"', bitrate: 160000, average_bitrate: 160000, has_audio: true }
  ];

  assert.equal(pickBestAudioFormat({ streaming_data: { adaptive_formats: formats } }).itag, 251);

  const tie = [
    { itag: 140, mime_type: 'audio/mp4; codecs="mp4a.40.2"', average_bitrate: 160000, has_audio: true },
    { itag: 251, mime_type: 'audio/webm; codecs="opus"', average_bitrate: 160000, has_audio: true }
  ];
  assert.equal(pickBestAudioFormat({ streaming_data: { adaptive_formats: tie } }).itag, 251);
});

test('honours a requested audio container when available', () => {
  const info = {
    streaming_data: {
      adaptive_formats: [
        { itag: 251, mime_type: 'audio/webm; codecs="opus"', average_bitrate: 160000, has_audio: true },
        { itag: 140, mime_type: 'audio/mp4; codecs="mp4a.40.2"', average_bitrate: 128000, has_audio: true }
      ]
    }
  };
  assert.equal(pickBestAudioFormat(info, { mimeIncludes: 'mp4' }).itag, 140);
});

function rangesFor(total) {
  return validationProbeRanges(total, 1024 * 1024, 1024 * 1024)
    .map(([start, end]) => `${start}-${end}`);
}

test('validates the URL start and a full second chunk', () => {
  assert.deepEqual(rangesFor(4_085_104), [
    '0-0',
    '1048576-2097151'
  ]);
});

test('handles tiny and unknown content lengths', () => {
  assert.deepEqual(validationProbeRanges(0, 1024, 64), [[0, 0]]);
  assert.deepEqual(validationProbeRanges(1, 1024, 64), [[0, 0]]);
  assert.deepEqual(rangesFor(1024), ['0-0', '1023-1023']);
});

test('extracts visitor data from the YouTube homepage config', () => {
  assert.equal(
    extractVisitorData('ytcfg.set({"VISITOR_DATA":"Cgtabc123%3D%3D","X":"y"})'),
    'Cgtabc123%3D%3D'
  );
  assert.equal(extractVisitorData('no visitor here'), '');
  assert.equal(extractVisitorData(''), '');
});

test('extracts the player signature timestamp from the watch page', () => {
  assert.equal(extractSignatureTimestamp('ytcfg.set({"STS":20767,"VISITOR_DATA":"x"})'), 20767);
  assert.equal(extractSignatureTimestamp('no sts here'), 0);
  assert.equal(extractSignatureTimestamp(''), 0);
});

test('builds a clean player request like yt-dlp does', () => {
  const client = PLAYER_CLIENTS.visionos;
  const body = playerRequestBody('8f6sRJ2BRtk', client);
  assert.equal(body.videoId, '8f6sRJ2BRtk');
  assert.equal(body.context.client.clientName, 'VISIONOS');
  assert.equal(body.context.client.clientVersion, '1.02');
  assert.equal(body.context.client.hl, 'en');
  assert.equal(body.context.client.timeZone, 'UTC');
  assert.equal(body.context.client.utcOffsetMinutes, 0);
  assert.equal(body.context.client.userAgent, client.userAgent);
  assert.equal(body.context.client.configInfo, undefined);
  assert.equal(body.contentCheckOk, true);
  assert.equal(body.racyCheckOk, true);
  assert.equal(body.playbackContext.contentPlaybackContext.signatureTimestamp, undefined);

  const withSts = playerRequestBody('8f6sRJ2BRtk', client, { signatureTimestamp: 20767 });
  assert.equal(withSts.playbackContext.contentPlaybackContext.signatureTimestamp, 20767);

  const headers = playerRequestHeaders(client, 'VISITOR123');
  assert.equal(headers['x-youtube-client-name'], '101');
  assert.equal(headers['x-youtube-client-version'], '1.02');
  assert.equal(headers['x-goog-visitor-id'], 'VISITOR123');
  assert.equal(headers.origin, 'https://www.youtube.com');
  assert.equal(headers['user-agent'], client.userAgent);
  assert.equal(headers['sec-fetch-mode'], 'navigate');

  const anonymous = playerRequestHeaders(client, '');
  assert.equal(anonymous['x-goog-visitor-id'], undefined);
});

test('normalizes player JSON formats into the bridge format shape', () => {
  const format = formatFromPlayerJson({
    itag: 251,
    mimeType: 'audio/webm; codecs="opus"',
    bitrate: 156272,
    averageBitrate: 158000,
    contentLength: '3340840',
    quality: 'tiny',
    audioQuality: 'AUDIO_QUALITY_MEDIUM',
    audioSampleRate: '48000',
    audioChannels: 2,
    url: 'https://rr1---sn-test.googlevideo.com/videoplayback?itag=251&clen=3340840'
  });
  assert.equal(format.itag, 251);
  assert.equal(format.mime_type, 'audio/webm; codecs="opus"');
  assert.equal(format.bitrate, 156272);
  assert.equal(format.average_bitrate, 158000);
  assert.equal(format.content_length, 3340840);
  assert.equal(format.audio_sample_rate, 48000);
  assert.equal(format.audio_channels, 2);
  assert.equal(format.has_audio, true);
  assert.equal(format.has_video, false);
});

test('derives content length from the URL when the player JSON omits it', () => {
  const format = formatFromPlayerJson({
    itag: 140,
    mimeType: 'audio/mp4; codecs="mp4a.40.2"',
    url: 'https://rr1---sn-test.googlevideo.com/videoplayback?itag=140&clen=4110525'
  });
  assert.equal(format.content_length, 4110525);
});

test('picks the highest-bitrate audio from a player response', () => {
  const playerJson = {
    streamingData: {
      adaptiveFormats: [
        { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 129000, averageBitrate: 128000, audioQuality: 'AUDIO_QUALITY_MEDIUM', url: 'https://x.test/a?itag=140' },
        { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 160000, averageBitrate: 160000, audioQuality: 'AUDIO_QUALITY_MEDIUM', url: 'https://x.test/a?itag=251' },
        { itag: 250, mimeType: 'audio/webm; codecs="opus"', bitrate: 70000, averageBitrate: 70000, audioQuality: 'AUDIO_QUALITY_LOW', url: 'https://x.test/a?itag=250' }
      ]
    }
  };
  assert.equal(pickBestAudioFromPlayerJson(playerJson).itag, 251);
  assert.equal(pickBestAudioFromPlayerJson(playerJson, { mimeIncludes: 'mp4' }).itag, 140);
  assert.equal(pickBestAudioFromPlayerJson(playerJson, { mimeIncludes: 'any' }).itag, 251);
});

test('ignores audio formats without a direct URL', () => {
  const playerJson = {
    streamingData: {
      adaptiveFormats: [
        { itag: 251, mimeType: 'audio/webm', bitrate: 160000, audioQuality: 'AUDIO_QUALITY_MEDIUM', signatureCipher: 's=abc&url=https%3A%2F%2Fx.test%2Fa' }
      ]
    }
  };
  assert.equal(pickBestAudioFromPlayerJson(playerJson), null);
});

test('picks the best video-only format and honours the container request', () => {
  const playerJson = {
    streamingData: {
      formats: [
        { itag: 18, mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', bitrate: 500000, height: 360, audioQuality: 'AUDIO_QUALITY_LOW', url: 'https://x.test/v?itag=18' }
      ],
      adaptiveFormats: [
        { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 4000000, height: 1080, url: 'https://x.test/v?itag=137' },
        { itag: 401, mimeType: 'video/mp4; codecs="av01.0.12M.08"', bitrate: 3000000, height: 1080, url: 'https://x.test/v?itag=401' },
        { itag: 248, mimeType: 'video/webm; codecs="vp9"', bitrate: 2500000, height: 1080, url: 'https://x.test/v?itag=248' }
      ]
    }
  };
  assert.equal(pickBestVideoFromPlayerJson(playerJson, { mimeIncludes: 'mp4' }).itag, 137);
  assert.equal(pickBestVideoFromPlayerJson(playerJson, { mimeIncludes: 'any' }).itag, 137);
  assert.equal(pickBestVideoFromPlayerJson(playerJson, { mimeIncludes: 'webm' }).itag, 248);
});

test('builds basic info from the player JSON', () => {
  const info = playerInfo({
    videoDetails: {
      videoId: '8f6sRJ2BRtk',
      title: 'Tribo da Periferia - Valores',
      author: 'Duckjay',
      lengthSeconds: '180',
      isLiveContent: false
    }
  }, 'ignored');
  assert.equal(info.basic_info.id, '8f6sRJ2BRtk');
  assert.equal(info.basic_info.title, 'Tribo da Periferia - Valores');
  assert.equal(info.basic_info.author, 'Duckjay');
  assert.equal(info.basic_info.channel.name, 'Duckjay');
  assert.equal(info.basic_info.duration, 180);
  assert.equal(info.basic_info.is_live, false);
});
