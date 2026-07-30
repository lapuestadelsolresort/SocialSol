# Media Pipeline — Operator Runbook

Indexes raw photo and video footage into a queryable library that agents in
`#social-sol`, `#prospector-paulina`, and `#reengager-regina` can search by
natural language, persona, setting, mood, and duration.

## Architecture at a glance

```
Source originals              Local derivatives                 Search index
─────────────────             ──────────────────────────       ────────────────
media/originals/<shoot>/     media/proxies/<shoot>/<id>.mp4    CRM SQLite (crm.db)
        A_CAM/*.MXF          media/thumbs/<shoot>/<id>/k*.jpg    ├── shoots
        B_CAM/*.MXF          media/waveforms/<shoot>/<id>.png    ├── media_assets
        DRONE/*.MP4          media/renditions/<shoot>/*.mp4      ├── media_transcripts
        AUDIO/*.WAV                                              ├── media_keyframe_captions
Google Drive folders          media/photos-cache/<shoot>/*       │
                                                                 └── media_clip_synopses
                                                                                │
                                                                                ▼
                                                                  Chroma "media_corpus"
                                                                                │
                                                                                ▼
                                                                  /api/media/search
                                                                       (localhost:3456)
```

Originals live outside version control under `media/originals/<shoot>/`.
Keep at least one checksum-verified offline backup. New footage uses the same
A_CAM/B_CAM/DRONE/AUDIO layout.

## File-type cheatsheet

| Extension | Source | Container / codec | Notes |
|---|---|---|---|
| `.MXF` (A_CAM, B_CAM) | Canon Cinema EOS | XF-AVC H.264 High 4:2:2 10-bit, 4K, 23.976p, PCM 24-bit/48 kHz audio | Stream timecode embedded; XML sidecar carries device serial + lens (B_CAM only) |
| `.XML` (A_CAM, B_CAM) | Canon sidecar | NewsML-G2 (A_CAM) or Canon `VideoClip` (B_CAM) | Sparse — no scene/take/slate; harvested at probe time |
| `.MP4` (DRONE) | DJI | HEVC Main, 4K, ~48 fps, with `djmd` + `dbgi` data streams (GPS/gimbal telemetry) | Telemetry recoverable via `ffmpeg -codec copy -map 0:d`, currently unused |
| `.LRF` (DRONE) | DJI low-res proxy | Standard MP4 H.264 720p, ~18 Mbps | Used as the proxy when present (higher fidelity than re-encoding the 4K HEVC; zero CPU). Not migrated to `media/originals/` — renamed/new drone files without an LRF are re-encoded from the 4K source automatically (generate-proxies fallback). |
| `.WAV` (AUDIO/HOME, HOST) | RØDE Wireless PRO | RIFF, 32-bit float, 48 kHz mono | No BWF/bext chunk — no embedded timecode. Per design, audio is indexed standalone (no A/V sync). Folder name = speaker role hint |

## Schema (migration `015_media_assets.sql`)

- `shoots(id, slug, source_root, ...)` — one row per body of footage
- `media_assets(id, shoot_id, source_role, kind, filename, source_path, proxy_path, thumb_dir, waveform_path, duration_ms, status, ...)`
- `media_transcripts(asset_id, source, language, text, segments_json, cost_usd)`
- `media_keyframe_captions(asset_id, frame_idx, frame_path, caption, tags_json, cost_usd)`
- `media_clip_synopses(asset_id, synopsis, searchable_text, tags_json, persona_fit_json, embedding_status, ...)`

State machine on `media_assets.status`:
`registered → proxied → transcribed (audio only) → captioned → indexed`

Each pipeline script advances the rows it can act on; re-runs are idempotent.

## Adding a new shoot

```bash
cd /path/to/SocialSol/media

# 1) Inventory the drive, register every file
node scripts/probe-and-register.js \
  --shoot-slug=2026-MM-DD-<descriptor> \
  --source-root=/Volumes/<DriveName> \
  --shoot-date=2026-MM-DD \
  --location='...' \
  --description='...'

# 2) Encode 720p H.264 proxies + extract keyframe JPEGs (videos only)
node scripts/generate-proxies.js --concurrency=2

# 3) Render waveform PNGs (audio only)
node scripts/generate-waveforms.js

# 4) Whisper transcripts (audio only, ~$0.006/min)
node scripts/transcribe.js --concurrency=1

# 5) Vision-LLM captions on every keyframe (~$0.007/frame, Sonnet 4.6)
node scripts/caption-keyframes.js --concurrency=3

# 6) Roll up keyframes + transcript into one synopsis per clip
node scripts/synthesize-clip.js --concurrency=2

# 7) Embed synopses into Chroma media_corpus
node scripts/index-media-corpus.sh

# 8) Sanity-check
curl -s 'http://localhost:3456/api/media/health' | jq .
```

Steps 2/3 and 4 can run concurrently (different bottlenecks — ffmpeg is CPU-local, Whisper is network). Step 5 runs after step 2 (needs the keyframe JPEGs). Step 6 runs after step 5. Step 7 picks up automatically the next morning via the LaunchAgent, or run it manually as shown.

## Adding a Google Drive folder

**One-time prerequisite (Workspace admin):**
Add the scope `https://www.googleapis.com/auth/drive.readonly` to the DWD
grant for the service account configured in `crm/lib/gmail-client.js`.
Google Workspace admin → Security → API controls → Domain-wide delegation →
edit client → append scope.

Then:

```bash
node scripts/sync-gdrive-folder.js \
  --folder-id=<FOLDER_ID> \
  --shoot-slug=<slug> \
  --shoot-date=YYYY-MM-DD \
  --location='...' \
  --description='...'

# Followed by steps 5–7 from "Adding a new shoot" above to caption + index.
```

**Without the scope:** copy/sync the photos locally (rclone, manual download, etc.), then use `register-photos.js`:

```bash
node scripts/register-photos.js \
  --shoot-slug=<slug> \
  --source-dir=<local-path> \
  --pattern='wedding-*.jpg' \
  --source-role=gdrive_photo \
  --gdrive-folder-id=<FOLDER_ID>
```

Use `register-photos.js` for any locally staged photo set.

## Agent query (the read path)

All endpoints are localhost-only.

```bash
# Top 3 video clips matching a brief, biased toward wedding-planner outreach
curl -s 'http://localhost:3456/api/media/search?q=intimate+sunset+over+the+villa&persona=wedding_planner_outreach&kind=video&limit=3' | jq .

# Full record for one asset (metadata + transcript + keyframe captions + synopsis)
curl -s 'http://localhost:3456/api/media/asset/241' | jq .

# Stream the 720p proxy in a browser
open 'http://localhost:3456/api/media/proxy/241'

# Pipeline counters
curl -s 'http://localhost:3456/api/media/health' | jq .
```

For Slack: `node scripts/find-media.js "<natural language>" --persona=<persona>` returns a Slack-friendly text block with thumb URLs and asset IDs that agents post into the channel.

`GET /api/media/list?limit=500&offset=0` is the flat paged inventory (no Chroma) — the media browser and audits use it.

## IG renditions (9:16 / 1:1)

Proxies are landscape; IG wants vertical or square. Render on demand per campaign pick (never in bulk):

```bash
node scripts/render-vertical.js --asset-id=<id> [--aspect=9x16|1x1] [--crop-x=0..1] [--from-proxy]
```

Renders 1080×1920 (or 1080×1080) H.264 from the 4K original on the drive
(`--from-proxy` explicitly accepts a 720p-derived fallback when the drive is
unmounted). Output: `media/renditions/<shoot>/<id>-<aspect>.mp4`, recorded in
`media_assets.renditions_json`, served at `GET /api/media/rendition/:id/:aspect`.
`--crop-x` shifts the crop window horizontally for off-center subjects.

## Weekly rescan

`scripts/rescan-sarah.sh` can be scheduled before the daily embed job to keep
the index in sync with the shoot selected by `MEDIA_SOURCE_SLUG`:

1. **Rename reconciliation:** assets whose `source_path` vanished are
   re-pointed at a same-directory file with an identical byte size (unique
   matches only — ambiguous or absent matches are logged for manual review).
   Captions/embeddings survive; costs nothing. This happens because drone
   files get renamed to descriptive names (e.g. `DJI_*_0049_D.MP4` →
   `adventure_experience.MP4`) after review.
2. Registers genuinely new files and runs steps 2–6 on them. Drone files
   without an `.LRF` pairing are re-encoded from the 4K source
   (generate-proxies falls back automatically).

Logs: `/tmp/media-rescan.log`. Run manually any time: `bash scripts/rescan-sarah.sh`.
To ingest new footage: drop files into the originals tree's
`A_CAM`/`B_CAM`/`DRONE`/`AUDIO/{HOME,HOST}` folders and wait for Monday, or
run the script. A brand-new shoot gets its own `media/originals/<slug>/`
directory and a manual probe-and-register run with a new `--shoot-slug`.

Supported personas (constrained vocab in `lib/tag-taxonomy.js`):

- `wedding_planner_outreach`
- `corporate_retreat_outreach`
- `past_guest_reactivation`
- `organic_social_aspirational`
- `paid_social_conversion`
- `landing_page_hero`

## Recovery

- **Chroma data dir wiped:** `UPDATE media_clip_synopses SET embedding_status='pending', embedded_at=NULL; UPDATE media_assets SET status=CASE WHEN status='indexed' THEN 'captioned' ELSE status END;` then run step 7.
- **One asset failed:** check `SELECT last_error FROM media_assets WHERE id=<id>`, fix the underlying issue, then run the affected script with `--reroll-failed`.
- **Re-caption everything for a shoot:** delete rows from `media_keyframe_captions` and `media_clip_synopses` where the asset belongs to that shoot, set `media_assets.status='proxied'` for those rows, re-run steps 5–7.
- **A_CAM XML schema changes / new camera body:** `probe-and-register.js:parseCanonSidecar` is the only consumer; extend that function.

## Tools required

```bash
brew install ffmpeg exiftool mediainfo jq
```

Node deps reuse `crm/node_modules` via the symlink at `media/node_modules`.

## Scheduling

Schedule `scripts/index-media-corpus.sh` with launchd or another service
manager after setting `SOCIALSOL_ROOT`, `SOCIALSOL_SECRETS_DIR`, and any API
credentials in the service environment. Machine-specific LaunchAgent files
are intentionally not committed.
