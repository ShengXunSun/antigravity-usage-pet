# Antigravity Gemini Usage Pet (`whale-pet`)

An interactive side-panel desktop pet plugin for **Google Antigravity** inspired by [`DeepSeek-Balance-Whale-Widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget).

It docks in Antigravity's Auxiliary Side Pane alongside your chat, displaying an interactive **Gemini Mascot Pet** that tracks your real-time token usage across conversations.

---

## ✨ Features

- **Overall Token Usage (`This Week` & `Last 5 Hours`)**
  - Automatically scans Antigravity's local conversation transcripts (`transcript.jsonl`) using fast incremental `mtime`/size caching.
  - Displays cumulative token totals and reply counts for the **Last 5 Hours** and **This Week (7 days)** across all chats (including subagents).

- **Input · Cache · Output Token Breakdown**
  - Dedicated breakdown card for **Input Tokens**, **Cache Read Tokens**, and **Output Tokens**.
  - Shows weekly token totals, percentage share bars, overall **Cache Hit Rate (`%`)**, and granular **`5h · Chat · Reply`** sub-metrics.

- **Current Chat Context Window Meter**
  - Live progress bar showing the exact number of tokens currently occupying your active chat's context window (`input_tokens + cache_read_tokens + output_tokens` of the latest model turn).
  - Switchable **`200k ⇄ 1M`** context cap badge with automatic model detection and a `/compact` reminder when context usage exceeds 80%.

- **Live Current Chat Badge on the Pet**
  - The speech bubble right above the Gemini Pet's head displays your active conversation's **`Last Reply`** tokens and **`This Chat`** cumulative total in real time.
  - Automatically reacts with a bounce and updated breakdown whenever a new reply finishes.

- **Interactive Gemini Pet & Zero-Overlap Sound Effect**
  - **Springy Click Bounce**: Clicking the pet triggers a `jellyBounce` squash-and-stretch animation and cycles through token summary lines.
  - **Single-Track `Nyaa` Audio**: Plays `nyaa.wav` via the Web Audio API (`AudioContext` + `AudioBufferSourceNode`). Rapid clicks immediately terminate the previous sound and restart from `0.00s` so tracks never overlap.
  - **`📌 Pinned / Unpinned` Toggle**: Keep the top usage cards pinned open while clicking the pet, or unpin them so clicking the pet toggles the dashboard open and closed.

---

## 📦 Installation

Clone this repository into your global Antigravity plugins directory:

```powershell
git clone https://github.com/ShengXunSun/antigravity-usage-pet.git "$env:USERPROFILE\.gemini\config\plugins\whale-pet"
```

---

## 🏷️ Git Version Checkpoints

Each development milestone is tagged so you can roll back at any time:

- `v0.1-base` — Initial side-panel plugin skeleton & HD dark-mode Gemini Pet sprite.
- `v0.2-tracker` — Incremental transcript token reader (`Last Reply`, `This Chat`, `Last 5h`, `This Week`).
- `v0.3-pet-ui` — Dedicated `Input · Cache · Output` token breakdown card & `📌 Pinned` toggle mode.
- `v0.4-sound` — Extracted `nyaa.wav` sound effect with single-track zero-overlap Web Audio playback.
- `v0.5-context-window` — Live `Chat Context Window` meter (`200k ⇄ 1M` cap) below the token breakdown section.
