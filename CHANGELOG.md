# Changelog

## 1.2.0 Orphic Realms package
- Serves the Rooms game (v0.1.33) at `/` from this same server; chat stays at `/?window=popup`.
- Game connects to the server it is loaded from, no address to type.


## 1.2.0 — Shared music in the Rooms
- New event `rooms:note`: what a player plays on the Music Room piano keys and chord pads is relayed live to everyone else in the same room. Notes are `{ t: 'on'|'off', m: midi note, k: tone }` and chords are `{ t: 'chord', m: root midi, c: chord type, k: tone }`.
- Checked on the server: the note range, the tone name and the chord name; at most 40 notes a second per player. Nothing is stored.
- Players who leave a room (or lose connection) are announced with `rooms:leave` as before, which also lets everyone silence any note they were holding.

## 1.0.2 — Flat repository layout

- Moved `index.html`, `app.js`, and `style.css` to the repository root so every project file can be uploaded together without any nested folders.
- Updated the server to serve the three browser files explicitly from the root. The server no longer relies on a `public/` directory.
- Updated the package check script and version metadata for the root-level `app.js`.
- Kept the no-account, no-database guest architecture from 1.0.1.

## 1.0.1 — Guest-first correction

- Removed account registration, login, passwords, logout, bcrypt, and session storage.
- Removed PostgreSQL and all database wiring from `render.yaml`.
- Render Blueprint creates one Free web service only.
- Added anonymous signed guest identities and online-player discovery for DMs.
- Each DM remains a separate channel keyed by the two guests' browser identities.
- Added local browser cache for recent messages and DM shortcuts.
- Added DM notifications so a recipient learns about a new conversation while online.
- Made temporary, in-memory server history explicit in the README and Options dialog.

## 1.1.0 — Rooms bridge (adds grab and pull)
- Renamed to realms.chat.
- New: the 3D Rooms page can connect (Socket.IO) to show real players per room, their positions, and speech bubbles. Events: `rooms:join`, `rooms:move`, `rooms:say`, `rooms:leave`.
- New: token identity for cross-site use (`POST /rooms-api/guest`), and `/adopt?t=` so the chat window opens as the same guest as the Rooms page.
- New env var `ROOMS_ORIGINS` (comma list of allowed sites, default `*`).
- Lines said in a room also appear in the realm-wide chat.
