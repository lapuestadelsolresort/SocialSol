'use strict';
//
// web-transcode.js — ffmpeg wrapper for landing-page hero videos.
//
// Produces a streaming-friendly 1080p H.264 MP4 from a 4K source.
// Defaults tuned for Cloudflare-served <video autoplay loop muted>:
//   - libx264 high profile, CRF 24, preset slow → typically 5–8 Mbps at 1080p
//     (content-adaptive — high-motion drone clips run higher, static scenes
//      lower). Operator can override via opts.crf.
//   - +faststart so the browser can begin playback before full download
//   - audio stripped (-an) — hero videos are muted by site convention
//   - scale=-2:1080 preserves aspect ratio and snaps width to even
//   - format=yuv420p — MXF/ProRes A-cam sources are typically yuv422p10le,
//     which libx264 high profile can't encode. Force 8-bit 4:2:0 (what web
//     players expect anyway).
//
// Used by provision-landing-video.js (operator CLI). Runs from the
// operator's shell so it can read /Volumes/<external>/ sources —
// the CRM server cannot, per feedback_launchd_tcc_external_volumes.

const { spawn } = require('child_process');

const DEFAULT_HEIGHT = 1080;
const DEFAULT_CRF = 24;
const DEFAULT_PRESET = 'slow';

function transcodeForWeb(input, output, opts = {}) {
  const height = opts.height || DEFAULT_HEIGHT;
  const crf = opts.crf != null ? opts.crf : DEFAULT_CRF;
  const startMs = opts.startMs || 0;
  const durMs = opts.durMs;
  const args = [];
  if (startMs > 0) args.push('-ss', (startMs / 1000).toFixed(3));
  args.push('-i', input);
  if (durMs) args.push('-t', (durMs / 1000).toFixed(3));
  args.push(
    '-vf', `scale=-2:${height},format=yuv420p`,
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-preset', DEFAULT_PRESET,
    '-crf', String(crf),
    '-movflags', '+faststart',
    '-an',
    '-y',
    output,
  );
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => reject(new Error(`ffmpeg spawn failed: ${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve({ output, elapsedMs: Date.now() - t0 });
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

module.exports = { transcodeForWeb, DEFAULT_HEIGHT, DEFAULT_CRF, DEFAULT_PRESET };
