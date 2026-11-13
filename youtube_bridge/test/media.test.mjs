import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatFromYtDlpUrl,
  musicItemPayload,
  normalizeSearchKey,
  pickBestAudioFormat,
  streamCacheTtlMs,
  validationProbeRanges,
  ytDlpFormatSelector
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

test('builds the yt-dlp format selector for audio and video', () => {
  assert.equal(ytDlpFormatSelector(undefined), 'bestaudio/best');
  assert.equal(ytDlpFormatSelector({ type: 'audio' }), 'bestaudio/best');
  assert.equal(ytDlpFormatSelector({ type: 'audio', format: 'any' }), 'bestaudio/best');
  assert.equal(ytDlpFormatSelector({ type: 'audio', format: 'mp4' }), 'bestaudio[ext=m4a]/bestaudio/best');
  assert.equal(ytDlpFormatSelector({ type: 'video' }), 'bestvideo/best');
  assert.equal(ytDlpFormatSelector({ type: 'video', format: 'mp4' }), 'bestvideo[ext=mp4]/bestvideo/best');
});

test('parses a yt-dlp audio URL into a bridge format', () => {
  const url =
    'https://rr5---sn-test.googlevideo.com/videoplayback?itag=251&mime=audio%2Fwebm&bitrate=156272&clen=3340840&dur=180';
  assert.deepEqual(formatFromYtDlpUrl(url), {
    url,
    itag: 251,
    mime_type: 'audio/webm',
    bitrate: 156272,
    average_bitrate: 156272,
    content_length: 3340840,
    quality: '',
    quality_label: '',
    audio_quality: '',
    audio_sample_rate: 0,
    audio_channels: 0,
    has_audio: true,
    has_video: false
  });
});

test('marks yt-dlp video-only URLs as video', () => {
  const format = formatFromYtDlpUrl(
    'https://rr5---sn-test.googlevideo.com/videoplayback?itag=401&mime=video%2Fmp4&clen=240334643'
  );
  assert.equal(format.mime_type, 'video/mp4');
  assert.equal(format.has_video, true);
  assert.equal(format.has_audio, false);
  assert.equal(format.content_length, 240334643);
});
