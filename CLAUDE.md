# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An interactive art installation: four physical "pillars" with RFID readers detect tagged objects ("ingredients"). Placing an ingredient on a pillar queues/plays a music clip in Ableton Live; removing it stops the clip. A React web UI (the "cauldron") visualizes what's playing, and a lighting server receives OSC events.

## Commands

Requires Node 21+ and yarn (classic). Ableton Live must be running with the [ableton-js](https://github.com/leolabs/ableton-js) MIDI remote script installed for the backend to start.

```bash
yarn install            # postinstall also installs backend/ deps
yarn start-backend      # nodemon backend/index.ts | pino-pretty
yarn dev                # Vite frontend at http://localhost:5173
yarn test               # vitest, single run
yarn test-filter <pat>  # vitest --testNamePattern (watch mode)
yarn coverage           # vitest with coverage
yarn lint               # eslint . --ext .ts,.tsx
yarn format             # prettier over the repo
yarn build              # tsc && vite build
```

Tests live in `spec/` (jsdom environment, setup in `spec/setup-tests.ts`, configured in `vite.config.ts`). Husky pre-commit runs lint-staged (eslint --max-warnings=0 + prettier) and runs tests if `src/` changed.

Ports/addresses come from the root `.env` (loaded by the backend via `dotenv` with path `../.env`): websocket server `WS_SEVER_PORT` (sic, typo is real) = 3335, OSC server `OSC_SERVER_PORT` = 9000, lighting server OSC client at `LIGHTING_SERVER_ADDRESS:LIGHTING_SERVER_PORT` (default 127.0.0.1:9001).

## Architecture

Two independently run halves sharing one repo:

- **`backend/`** — a Node process (own `package.json`/`yarn.lock`, run with ts-node via nodemon) that bridges three worlds: an OSC server receiving `/new/tag` and `/departed/tag` from the RFID Arduinos, a socket.io server for the web UI, and `ableton-js` controlling Ableton Live. `backend/index.ts` wires these; nearly all logic and mutable state (playing/queued/stopping clips, master key, key lock) lives in `backend/ableton-api.ts` as module-level exports.
- **`src/`** — React 18 + Vite + Tailwind frontend. Provider nesting in `src/main.tsx` is Logger → Socketio → Ableton. `src/contexts/ableton-provider.tsx` mirrors backend state by listening to socket.io events and exposes it via `AbletonContext`; components never talk to the backend directly.

The frontend imports backend code directly (e.g. `import { ... } from 'backend/types'`) — the root `tsconfig.json` sets `baseUrl: "."` with `~/*` → `src/*`, and Vite resolves it via `vite-tsconfig-paths`. Types and the CSV parser in `backend/` are shared code, so changes there affect both halves.

### Pillars

A pillar index (0–3) is the central coordinate: it maps to Ableton tracks 0–3 and to hardcoded RFID-reader IPs 192.168.0.101–104 (`IP_ADDRESS_TO_PILLAR_INDEX_MAP` in `backend/events/incoming-events.ts`). Each pillar hosts one clip type (Drums, Melody, Bass, Vox).

### Music Database CSV

`src/assets/Music Database.csv` maps RFID tags → clip metadata (clip name, type, artist, musical key, ingredient name). It is parsed twice with the shared `backend/utils/parse-csv.ts`: the backend reads it from disk with papaparse (`backend/utils/get-clip-from-rfid.ts`, path relative to `backend/` as cwd), and the frontend imports it at build time via `@rollup/plugin-dsv` (`src/lib/database-output.ts`). Clip names in the CSV must match Ableton clip names (comparison strips spaces and `*`).

### Clip lifecycle (backend)

- **Loops**: a "song" in Ableton is a block of consecutive clip slots with the same clip name on a track; `FindAllClipsInLoop` (memoized) locates the block. Firing the first clip plays the block.
- **Queueing**: a new tag queues a clip (`QueueClip`); if nothing is playing it fires immediately. Queued clips are triggered at phrase boundaries by the **phrase leader** — the highest-priority playing clip per `TRIGGER_ORDER` (Drums > Melody > Bass > Vox). A `playing_position` listener on the leader fires the queue when its loop end approaches (`AddPhraseLeader`).
- **State tracking**: the source of truth for what's playing is Ableton's `playing_slot_index` listener per track (set up in `GetTracksAndClips`), not the queue actions — this emits `clip_started`/`clip_stopped` etc. to clients.
- **Key lock**: when enabled (default), clips are pitch-shifted (`pitch_coarse`) to the master key using the Camelot-wheel table in `backend/key-transpositions.ts`. The master key is set by the first clip played from silence. Stopped/replaced clips must be transposed back to 0.
- **Timeout**: `EmitEvent` (in `backend/events/outgoing-events.ts`) resets a 3-minute inactivity timer; on expiry all clips stop. Use `EmitEventWithoutResetingTimout` for events that shouldn't count as activity.

Every outgoing event is emitted both to all socket.io clients and as an OSC message to the lighting server, namespaced as `/{pillar+1}/{eventName}` when the payload has a pillar, else `/{eventName}`.

### Arduino (`Arduino/`)

Standalone sketches, not part of the Node build: `Unit_RFID_M5Core` (M5Stack RFID reader that broadcasts `/new/tag` / `/departed/tag` OSC on port 9000; each unit needs a hardcoded static IP matching the pillar map) and `ArtnetWifiFastLED` (Art-Net → WS2812 LED control).
