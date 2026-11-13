# Antigravity Gemini usage pet

`whale-pet` `v1.0` sets plugin version `1.0.0` and runs a local Node.js sidecar panel in the Google Antigravity auxiliary side pane. `UsageTracker` reads local `transcript.jsonl` files from your Antigravity `brain` directories and serves live totals over loopback HTTP. The panel displays token usage, context window composition, and an interactive mascot for Gemini and Claude models. Every calculation runs locally in JavaScript and spends zero model tokens.

## Installation and updates

`git clone` installs the plugin into the global Antigravity plugins directory:

	git clone https://github.com/ShengXunSun/antigravity-usage-pet.git "$env:USERPROFILE\.gemini\config\plugins\whale-pet"

`git pull` updates an installed copy in place:

	git -C "$env:USERPROFILE\.gemini\config\plugins\whale-pet" pull

## Dashboard cards and controls

- **Overall Token Usage.** Displays cumulative tokens and user-turn reply counts for **This Week** over 7 days and **Daily** over 24 hours. Totals include subagent spend, while multi-step tool loops within one prompt count as one reply. The header shows the 8-character conversation ID prefix, `#reload-btn`, the **Pinned** and **Unpinned** toggle on `#pin-btn`, and the `Live`, `Error`, or `Offline` state on `#status-badge`. `app.js` stores pin and collapse state in `localStorage` under `gemini_pet_ui_state`.
- **Weekly Input, Cache, and Output Tokens.** Displays 7-day token totals, percentage bars, and prompt **Cache Hit** rate computed as `cache / (input + cache)`. Each row lists **Daily**, **Chat**, and **Reply** sub-totals. Pointer hover over `#ico-card` switches the title, bars, and **Cache Hit** badge to the active chat's 7-day totals, or all-time chat totals when 7-day chat spend is zero.
- **Chat Context Window.** Displays active context size from the latest model step as `input_tokens + cache_read_tokens + output_tokens`. Right after a `CHECKPOINT` compaction, `#sub-ctx` appends `Auto-compacted @ Xk` and displays the post-compaction size. At `80%` of cap or above, `#sub-ctx` appends a `/compact` hint. `#ctx-cap-btn` toggles between `200k` and `1M` limits per model family in `gemini_pet_ctx_cap_v2`. Pointer hover over `#ctx-card` reveals `#ctx-tooltip`, and pointer leave hides it immediately. On panes `640px` tall or shorter, `#ctx-tooltip` flips above `#ctx-card` and breaks down four categories with Hamilton largest-remainder percentages:
  - **Tools & Outputs** in `#38bdf8` estimates tool call arguments and tool responses.
  - **Chat Messages** in `#34d399` estimates user prompts, model replies, and checkpoint summaries.
  - **System & Skills** in `#fbbf24` estimates system instructions and skill declarations from the first model step.
  - **Model Thinking** in `#f43f5e` estimates model reasoning blocks.
- **Mascot stage, speech bubble, and audio.** `#speech-bubble` displays **Last Reply** tokens for the latest non-empty turn and **This Chat** cumulative tokens. `tracker.mjs` parses `<USER_SETTINGS_CHANGE>` entries to set a `1M` default cap for Gemini or `200k` for Claude and OpenAI models, and `app.js` loads only `pet.png` or `pet-claude.png`. CSS Flexbox scales `#pet-stage` and `#pet-avatar` so panes at `600px` and `820px` heights fit without vertical scrollbars. A click on `#pet-stage` triggers `jellyBounce`, cycles four summary lines, toggles the dashboard when **Unpinned**, and plays `nyaa.wav` from `0.00s` without overlap. `app.js` polls `POST /api/usage` every `1500 ms` while visible and pauses when `document.hidden` is true.

## Repository layout

- `plugin.json` and `assets/logo.png` define the `1.0.0` Antigravity plugin manifest and icon.
- `sidecars/pet_panel/sidecar.json` registers the `node main.mjs` auxiliary pane view at `"/"`.
- `sidecars/pet_panel/main.mjs` preloads static assets in memory and computes a 10-character SHA-256 `ASSET_VERSION` for `immutable` cache headers. It serves `"/"` and legacy `"/v21"` HTML with `no-store`, validates `X-Sidecar-Token` on `POST /api/usage`, and increments `assetVersion` on `GET /api/usage` to reload stale iframes.
- `sidecars/pet_panel/tracker.mjs` exports `UsageTracker` with byte-offset incremental `transcript.jsonl` reads and 64-byte head and tail signature checks. It separates subagent transcripts from user chats, prunes entries older than 8 days, and short-circuits unchanged `sinceRev` polls.
- `sidecars/pet_panel/index.html`, `sidecars/pet_panel/styles.css`, and `sidecars/pet_panel/app.js` render the `#1d1e22` dark interface, hover tooltips, and lazy Web Audio playback. `app.js` forwards modifier key chords to the parent host frame via `sidecar-key-event` and skips `/preload.js`.
- `sidecars/pet_panel/pet.png`, `sidecars/pet_panel/pet-claude.png`, and `sidecars/pet_panel/nyaa.wav` store the losslessly filtered PNG sprites and trimmed 24 kHz mono sound effect.
- `test/tracker.test.mjs` and `test/server.test.mjs` contain the 11 unit and HTTP integration tests.
- `scripts/bench.mjs`, `scripts/optimize-assets.mjs`, `scripts/log-decision.mjs`, and `decisions.tsv` contain the 7-trial A and B benchmark harness, lossless PNG and WAV optimizer, and append-only decision log.

## Verification and asset commands

`node --test` runs the 11 unit and HTTP integration tests from the repository root:

	node --test

`scripts/bench.mjs` runs the 7-trial interleaved A and B benchmark against `v0.7-save`:

	node scripts/bench.mjs

`scripts/optimize-assets.mjs` runs the idempotent lossless PNG and WAV optimizer:

	node scripts/optimize-assets.mjs

## Version tags

- `v0.1-base` adds the initial sidecar panel and dark-mode Gemini mascot sprite.
- `v0.2-tracker` adds transcript token scanning across recent time windows.
- `v0.3-pet-ui` adds the input, cache, and output breakdown card and pin toggle.
- `v0.4-sound` adds single-track Web Audio playback for `nyaa.wav`.
- `v0.5` and `v0.5-context-window` add the context window meter, compaction note, and four-color breakdown tooltip.
- `v0.6` and `v0.7` add automatic Claude mascot selection and updated Claude sprite artwork.
- `v0.7-save` marks the pre-optimization checkpoint before the incremental engine rewrite.
- `v0.8` adds byte-offset `UsageTracker` parsing, `POST /api/usage` token checks, immutable hashed assets, lossless asset compression, Flexbox pane layout, hover-only `#ctx-tooltip` display, and the `node:test` and `bench.mjs` suites.
- `v1.0` releases version `1.0.0` with hover-only card parity, verified real-transcript totals, and complete reference documentation.
