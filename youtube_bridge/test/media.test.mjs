import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  DEVICE_CLIENTS,
  LOGGED_IN_CLIENTS,
  PLAYER_CLIENTS,
  appendPoToken,
  buildSapisidAuthorization,
  extractSessionIndex,
  extractSignatureTimestamp,
  extractUserSessionId,
  extractVisitorData,
  isLoggedInPage,
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
  const client = PLAYER_CLIENTS.mweb;
  const body = playerRequestBody('8f6sRJ2BRtk', client);
  assert.equal(body.videoId, '8f6sRJ2BRtk');
  assert.equal(body.context.client.clientName, 'MWEB');
  assert.equal(body.context.client.clientVersion, '2.20260708.05.00');
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
  assert.equal(headers['x-youtube-client-name'], '2');
  assert.equal(headers['x-youtube-client-version'], '2.20260708.05.00');
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

test('extracts the account session id from the watch page', () => {
  assert.equal(
    extractUserSessionId('ytcfg.set({"DATASYNC_ID":"abcd||efgh123","X":1})'),
    'efgh123'
  );
  assert.equal(
    extractUserSessionId('ytcfg.set({"USER_SESSION_ID":"direct-session"})'),
    'direct-session'
  );
  assert.equal(extractUserSessionId('ytcfg.set({"DATASYNC_ID":"nosession"})'), '');
  assert.equal(extractUserSessionId(''), '');
});

test('extracts the session index and logged-in flag', () => {
  assert.equal(extractSessionIndex('ytcfg.set({"SESSION_INDEX":2})'), 2);
  assert.equal(extractSessionIndex('ytcfg.set({"SESSION_INDEX":"3"})'), 3);
  assert.equal(extractSessionIndex('nothing'), 0);

  assert.equal(isLoggedInPage('ytcfg.set({"LOGGED_IN":true})'), true);
  assert.equal(isLoggedInPage('ytcfg.set({"LOGGED_IN":false})'), false);
  assert.equal(isLoggedInPage(''), false);
});

test('builds SAPISIDHASH authorization from the cookies', () => {
  const nowSeconds = 1_800_000_000;
  const cookieHeader = [
    'VISITOR_INFO1_LIVE=abc',
    '__Secure-3PAPISID=papisid3',
    '__Secure-1PAPISID=papisid1'
  ].join('; ');
  const authorization = buildSapisidAuthorization(cookieHeader, 'session-1', { nowSeconds });
  const sapisid3 = createHash('sha1')
    .update(`session-1 ${nowSeconds} papisid3 https://www.youtube.com`)
    .digest('hex');
  const sapisid1 = createHash('sha1')
    .update(`session-1 ${nowSeconds} papisid1 https://www.youtube.com`)
    .digest('hex');

  assert.equal(
    authorization,
    `SAPISIDHASH ${nowSeconds}_${sapisid3}_u SAPISID1PHASH ${nowSeconds}_${sapisid1}_u SAPISID3PHASH ${nowSeconds}_${sapisid3}_u`
  );
  assert.equal(buildSapisidAuthorization('', 'session-1', { nowSeconds }), '');
});

test('sends the account session only to clients that support it', () => {
  const headers = playerRequestHeaders(PLAYER_CLIENTS.mweb, 'VISITOR123', {
    cookie: 'SAPISID=x',
    authorization: 'SAPISIDHASH 1_abc_u',
    sessionIndex: 2,
    loggedIn: true
  });
  assert.equal(headers.cookie, 'SAPISID=x');
  assert.equal(headers.authorization, 'SAPISIDHASH 1_abc_u');
  assert.equal(headers['x-goog-authuser'], '2');
  assert.equal(headers['x-youtube-bootstrap-logged-in'], 'true');
  assert.equal(headers['x-origin'], 'https://www.youtube.com');
});

test('appends the PO token without dropping existing query parameters', () => {
  const url = appendPoToken('https://rr1---sn-test.googlevideo.com/videoplayback?itag=251&n=abc', 'TOKEN');
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('itag'), '251');
  assert.equal(parsed.searchParams.get('n'), 'abc');
  assert.equal(parsed.searchParams.get('pot'), 'TOKEN');
  assert.equal(appendPoToken('https://x.test/a', ''), 'https://x.test/a');
  assert.equal(appendPoToken('', 'TOKEN'), '');
});

test('selects ciphered formats only when explicitly allowed', () => {
  const playerJson = {
    streamingData: {
      adaptiveFormats: [
        {
          itag: 251,
          mimeType: 'audio/webm; codecs="opus"',
          bitrate: 160000,
          averageBitrate: 160000,
          signatureCipher: 's=abc&sp=sig&url=https%3A%2F%2Fx.test%2Fa%3Fitag%3D251'
        }
      ]
    }
  };
  assert.equal(pickBestAudioFromPlayerJson(playerJson), null);
  const cipher = pickBestAudioFromPlayerJson(playerJson, { allowCiphered: true });
  assert.equal(cipher.itag, 251);
  assert.match(cipher.signature_cipher, /^s=abc/);
  assert.equal(cipher.url, '');
});

test('selects ciphered video formats only when explicitly allowed', () => {
  const playerJson = {
    streamingData: {
      adaptiveFormats: [
        {
          itag: 137,
          mimeType: 'video/mp4; codecs="avc1.640028"',
          bitrate: 4000000,
          height: 1080,
          signatureCipher: 's=abc&url=https%3A%2F%2Fx.test%2Fv%3Fitag%3D137'
        }
      ]
    }
  };
  assert.equal(pickBestVideoFromPlayerJson(playerJson), null);
  assert.equal(pickBestVideoFromPlayerJson(playerJson, { allowCiphered: true }).itag, 137);
});

test('uses the cookie-only device client first and MWEB/WEB_CREATOR for the account path', () => {
  assert.deepEqual(LOGGED_IN_CLIENTS, ['mweb', 'web_creator']);
  for (const key of LOGGED_IN_CLIENTS) {
    assert.equal(PLAYER_CLIENTS[key].sendCookies, true);
    assert.notEqual(PLAYER_CLIENTS[key].sendAuth, false);
    assert.equal(PLAYER_CLIENTS[key].context.clientName, PLAYER_CLIENTS[key].name);
    assert.ok(PLAYER_CLIENTS[key].userAgent);
  }
  // The device client still carries the cookies, but YouTube rejects
  // SAPISIDHASH on it and its URLs need no PO token.
  assert.deepEqual(DEVICE_CLIENTS, ['visionos']);
  const device = PLAYER_CLIENTS.visionos;
  assert.equal(device.sendCookies, true);
  assert.equal(device.sendAuth, false);
  assert.equal(device.needsPoToken, false);
  assert.deepEqual(Object.keys(PLAYER_CLIENTS).sort(), ['mweb', 'visionos', 'web_creator']);
});
