# Moodify

Type how you feel, get music that fits. Moodify reads a short mood prompt ("rainy evening, a bit nostalgic"), finds public Spotify playlists that match it, and builds a 10-track mix you can save to your own Spotify account in one click.

**Live:** https://moodify-pearl-sigma.vercel.app
**API:** https://moodify-a605.onrender.com

---

## How it works

1. **You describe a mood** in plain language.
2. **Gemini interprets it.** The backend asks Google Gemini for three things: a short playlist title, a 1-2 word playlist search term, and three track search keywords. If Gemini is slow (over 3.5 s) or fails, a local keyword fallback takes over so the app still answers.
3. **Spotify is searched** with an app-level token (no login needed): up to 6 public playlists, plus up to 10 unique tracks sorted by popularity.
4. **You get two results:**
   - *Existing Spotify Playlists*: public playlists you can open straight away.
   - *Your AI Custom Mix*: a titled set of 10 tracks.
5. **Save to My Spotify.** After linking your account (Spotify OAuth), Moodify creates the playlist in your library and opens it.

```
Browser (Vercel)                 FastAPI (Render)                  External
---------------                  ----------------                  --------
mood prompt  ---- POST /api/mood ---->  Gemini (title + keywords)  -> Google Gemini
                                        Spotify search (app token) -> Spotify Web API
             <--- playlists + tracks ---

Link Spotify ---- GET /login -------->  redirect to Spotify consent (CSRF state cookie set)
             <--- /callback ----------  state checked, token returned in the URL #fragment

Save         ---- POST /api/create-playlist (Bearer token) -> creates playlist in user's library
```

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | HTML, vanilla JavaScript, hand-written CSS | No framework, no build step, fast first load |
| Frontend hosting | Vercel (+ Web Analytics) | Free, Git-based deploys |
| Backend | Python, FastAPI, Uvicorn | Async, small, fast to write |
| Backend hosting | Render free tier, kept warm by UptimeRobot pings | Free |
| AI | `google-genai` SDK, Gemini Flash | Fast, cheap text-to-JSON |
| Music | `spotipy` (Spotify Web API) | Search, OAuth, playlist creation |

---

## Project structure

```
Moodify/
├── Moodify_backend/
│   ├── main.py            # FastAPI app: OAuth, mood analysis, playlist creation
│   └── requirements.txt
└── Moodify_frontend/
    ├── index.html         # Single page UI
    ├── app.js             # Auth flow, API calls, rendering
    ├── styles.css         # All styling (design tokens at the top)
    ├── moodify_icon.png
    └── Spotify.png
```

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET, HEAD | `/` | none | Health check (used by the uptime pinger) |
| GET | `/login` | none | Redirects to Spotify sign-in with a CSRF `state` |
| GET | `/callback` | none | Verifies `state`, exchanges the code, returns to the frontend |
| POST | `/api/mood` | none | `{ "prompt": "..." }` → derived mood, playlists, tracks |
| POST | `/api/create-playlist` | Bearer | `{ "title": "...", "track_uris": [...] }` → new playlist URL |
| GET | `/api/me` | Bearer | Current user's display name and avatar |

---

## Run it locally

**1. Spotify app.** Create one at https://developer.spotify.com/dashboard and add `http://127.0.0.1:8000/callback` as a Redirect URI.

**2. Backend**

```bash
cd Moodify_backend
python -m venv venv
venv\Scripts\activate          # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt
```

Create `Moodify_backend/.env` (never commit it):

```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8000/callback
GEMINI_API_KEY=your_gemini_key
FRONTEND_URL=http://127.0.0.1:5500
```

```bash
uvicorn main:app --reload --port 8000
```

**3. Frontend.** Serve `Moodify_frontend` with VS Code Live Server (port 5500) and open `http://127.0.0.1:5500`. When the page runs on `127.0.0.1` or `localhost` it talks to the local backend automatically; on Vercel it uses the Render API.

## Deploy

- **Backend (Render):** root `Moodify_backend`, build `pip install -r requirements.txt`, start `uvicorn main:app --host 0.0.0.0 --port $PORT`. Add the `.env` values as environment variables, with the production redirect URI and frontend URL. Optional: `ALLOWED_ORIGINS` (comma-separated) if the API must accept more origins than `FRONTEND_URL`, `GEMINI_MODEL`, `GEMINI_TIMEOUT_S`.
- **Frontend (Vercel):** root `Moodify_frontend`, no build command.
- **Spotify dashboard:** add the production `/callback` URL. While the Spotify app is in Development Mode, only users added to its allowlist can link accounts and save playlists.

---

## Security notes

- OAuth `state` is checked against a short-lived HttpOnly cookie on `/callback`.
- User tokens are never written to the server's disk and are returned in the URL fragment, so they don't appear in server logs.
- Spotify data is rendered with `textContent` and only `https` links and images are allowed.
- CORS allows only the listed frontend origins.

## Known limitations and roadmap

- Render's free tier can still cold-start, so the first request after idle may be slow.
- The 10 mix tracks are not shown before saving; a preview list is planned.
- Spotify access tokens last one hour and are not refreshed; after that, users link Spotify again.
- Vercel preview deployments use different URLs, so add them to `ALLOWED_ORIGINS` if you test on previews.

## Author

Built by Ali, B.Sc. Information Technology and Data Management, Arab Open University (Bahrain).
