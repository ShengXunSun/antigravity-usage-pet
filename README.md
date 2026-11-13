# Antigravity Gemini usage pet

`whale-pet` runs a local Node.js panel inside the Google Antigravity auxiliary side pane. It reads local `transcript.jsonl` files from your Antigravity `brain` directories and displays token usage, context window size, and an interactive mascot for Gemini and Claude models. All accounting runs locally in JavaScript and spends zero model tokens.

## Install the plugin

Clone this repository into your global Antigravity plugins directory:

	git clone https://github.com/ShengXunSun/antigravity-usage-pet.git "$env:USERPROFILE\.gemini\config\plugins\whale-pet"

## Dashboard cards and controls

`sidecars/pet_panel/main.mjs` serves the panel on `127.0.0.1` and authenticates live `POST /api/usage` polls with `X-Sidecar-Token`. `sidecars/pet_panel/tracker.mjs` reads appended bytes from each `transcript.jsonl` file by byte offset and checks 64-byte head and tail signatures before advancing.

- **Overall token usage.** Shows token totals and user-turn reply counts for **Daily** over 24 hours and **This Week** over 7 days, including subagent logs. Click **Pinned** or **Unpinned** to control whether mascot clicks collapse the cards.
- **Weekly input, cache, and output tokens.** Shows 7-day totals, share bars, and prompt **Cache Hit** rate computed as `cache / (input + cache)`. Each column lists **Daily**, **Chat**, and **Reply** sub-totals. Hover the card to inspect 7-day input, cache, and output totals for the active chat.
- **Chat context window.** Displays the active context size from the latest model step, or the post-compaction estimate after a `CHECKPOINT` event. Click **Cap** to switch between `200k` and `1M` limits for the active model family. Hover the card to inspect a four-part composition bar with Hamilton largest-remainder percentages:
  - **Tools & Outputs** in `#38bdf8` estimates tool call arguments and outputs.
  - **Chat Messages** in `#34d399` estimates user prompts, model replies, and checkpoint summaries.
  - **System & Skills** in `#fbbf24` estimates system instructions and skill declarations from the first model step.
  - **Model Thinking** in `#f43f5e` estimates model reasoning blocks.
- **Model mascot and audio.** Switches between `sidecars/pet_panel/pet.png` for Gemini chats and `sidecars/pet_panel/pet-claude.png` for Claude chats using `<USER_SETTINGS_CHANGE>` entries in the active transcript. Click the mascot to trigger `jellyBounce`, cycle summary lines, and play `sidecars/pet_panel/nyaa.wav` from `0.00s` without track overlap.

## Run tests and benchmarks

Run the 11 unit and HTTP integration tests across `test/tracker.test.mjs` and `test/server.test.mjs`:

	node --test

Run the 7-trial interleaved A and B benchmark against `v0.7-save`:

	node scripts/bench.mjs

Run the lossless PNG and WAV asset optimizer:

	node scripts/optimize-assets.mjs

## Version tags

- `v0.1-base` adds the initial sidecar panel and dark-mode Gemini mascot sprite.
- `v0.2-tracker` adds transcript token scanning across recent time windows.
- `v0.3-pet-ui` adds the input, cache, and output breakdown card and pin toggle.
- `v0.4-sound` adds single-track Web Audio playback for `nyaa.wav`.
- `v0.5` and `v0.5-context-window` add the context window meter, compaction badge, and four-color breakdown tooltip.
- `v0.6` and `v0.7` add automatic Claude mascot switching and updated Claude sprite artwork.
- `v0.7-save` marks the pre-optimization checkpoint before the `v0.8` audit pass.
- `v0.8` adds byte-offset `UsageTracker` parsing, `POST /api/usage` token authentication, immutable hashed asset caching, lossless asset compression, responsive pane sizing, and the `node:test` and `bench.mjs` suites.
