'use strict';
//
// ffmpeg-helpers.js — thin wrappers around ffmpeg/ffprobe for the media
// pipeline. Each helper returns a Promise<void> (or Promise<object> for
// probe). All shell-quote inputs and avoid string interpolation.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] });
    let stdout = '', stderr = '';
    if (capture) {
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
    }
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        const tail = (stderr || '').split('\n').slice(-6).join('\n');
        return reject(new Error(`${cmd} exited ${code}: ${tail}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

async function ffprobeJson(filePath) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_streams', '-show_format',
    '-print_format', 'json',
    filePath,
  ], { capture: true });
  return JSON.parse(stdout);
}

function probeSummary(probe) {
  const fmt = probe.format || {};
  const streams = probe.streams || [];
  const v = streams.find(s => s.codec_type === 'video');
  const a = streams.find(s => s.codec_type === 'audio');
  const durationSec = parseFloat(fmt.duration || (v && v.duration) || (a && a.duration) || '0');
  const createdRaw = (fmt.tags && (fmt.tags.creation_time || fmt.tags.date))
    || (v && v.tags && v.tags.creation_time)
    || null;
  let fps = null;
  if (v && v.avg_frame_rate && v.avg_frame_rate !== '0/0') {
    const [num, den] = v.avg_frame_rate.split('/').map(Number);
    if (den) fps = num / den;
  }
  return {
    container: fmt.format_name || null,
    duration_ms: Math.round(durationSec * 1000),
    size_bytes: fmt.size ? parseInt(fmt.size, 10) : null,
    codec_v: v ? v.codec_name : null,
    codec_a: a ? a.codec_name : null,
    width: v ? v.width : null,
    height: v ? v.height : null,
    fps,
    sample_rate: a && a.sample_rate ? parseInt(a.sample_rate, 10) : null,
    channels: a ? a.channels : null,
    source_created_at: createdRaw || null,
  };
}

// 720p H.264 yuv420p proxy. veryfast preset balances encode time vs. size;
// crf 23 lands ~150-200 kbps on talking-head B-roll and ~600 kbps on
// motion-heavy aerial footage. yuv420p sheds the 4:2:2 10-bit XF-AVC chroma
// so QuickTime/Chrome/Slack all play the proxy without a fight.
async function makeProxy(srcPath, dstPath) {
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  await run('ffmpeg', [
    '-y',
    '-i', srcPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', 'scale=-2:720',
    '-c:v', 'libx264',
    '-crf', '23',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    dstPath,
  ]);
}

// N keyframes evenly spaced across the clip, 480p JPEGs.
async function makeThumbs(srcPath, dstDir, n = 4) {
  fs.mkdirSync(dstDir, { recursive: true });
  // We use fps=N/duration via -vf fps=1/X where X = duration/n.
  // Simplest reliable form: select N evenly-spaced frames via
  // "select='not(mod(n,floor(NB_FRAMES/N)))'". Simpler still: use the
  // duration-derived approach by probing first.
  const probe = await ffprobeJson(srcPath);
  const sum = probeSummary(probe);
  const durSec = (sum.duration_ms || 0) / 1000;
  const target = Math.max(1, n);
  // Pick interval so we get exactly `target` frames spread across the clip,
  // offset by ~10% from each end so we miss the slate and the head-out.
  const offset = durSec * 0.1;
  const span = Math.max(0.5, durSec - 2 * offset);
  const step = span / Math.max(1, target - 1);
  // Build a list of select expressions for explicit timestamps.
  const tsList = [];
  for (let i = 0; i < target; i++) {
    tsList.push(offset + i * step);
  }
  // ffmpeg can't easily emit N stills at specific timestamps in one pass
  // without -ss/-vframes loops. Loop is more predictable.
  const paths = [];
  for (let i = 0; i < tsList.length; i++) {
    const ts = tsList[i].toFixed(3);
    const outPath = path.join(dstDir, `k${String(i).padStart(2, '0')}.jpg`);
    await run('ffmpeg', [
      '-y',
      '-ss', ts,
      '-i', srcPath,
      '-frames:v', '1',
      '-vf', 'scale=-2:480',
      '-q:v', '4',
      outPath,
    ]);
    paths.push({ frame_idx: i, frame_path: outPath, timestamp_ms: Math.round(tsList[i] * 1000) });
  }
  return paths;
}

// Waveform PNG for an audio asset — useful for human scrub previews if we
// ever stand up a /api/media/waveform/:id endpoint.
async function makeWaveform(srcPath, dstPath) {
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  await run('ffmpeg', [
    '-y',
    '-i', srcPath,
    '-filter_complex', 'showwavespic=s=1200x200:colors=0x4a90e2',
    '-frames:v', '1',
    dstPath,
  ]);
}

// Extract a downsampled 16 kHz mono WAV from an audio source for Whisper.
// Whisper accepts up to 25 MB; 16 kHz mono pcm_s16le is ~32 kB/s so ~13
// minutes per call. For audio assets > ~12 min we chunk in transcribe.js.
async function extractAudioForWhisper(srcPath, dstPath, { startSec = 0, durationSec = null } = {}) {
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  const args = ['-y'];
  if (startSec > 0) args.push('-ss', String(startSec));
  if (durationSec) args.push('-t', String(durationSec));
  args.push(
    '-i', srcPath,
    '-vn',
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'pcm_s16le',
    dstPath,
  );
  await run('ffmpeg', args);
}

module.exports = {
  ffprobeJson,
  probeSummary,
  makeProxy,
  makeThumbs,
  makeWaveform,
  extractAudioForWhisper,
  run,
};
