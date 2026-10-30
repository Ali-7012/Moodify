import os
import time
import json
import secrets
from fastapi import FastAPI, Request, HTTPException, Header
from fastapi.responses import RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import spotipy
from spotipy.oauth2 import SpotifyOAuth, SpotifyClientCredentials
from google import genai

load_dotenv()

SPOTIFY_CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID")
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET")
SPOTIFY_REDIRECT_URI = os.getenv("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8000/callback")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://moodify-pearl-sigma.vercel.app").rstrip('/')

genai_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

# Set cache_handler=None to prevent multi-user token bleeding on hosted server
sp_oauth = SpotifyOAuth(
    client_id=SPOTIFY_CLIENT_ID,
    client_secret=SPOTIFY_CLIENT_SECRET,
    redirect_uri=SPOTIFY_REDIRECT_URI,
    scope="playlist-modify-public user-read-private",
    cache_handler=None
)

app = FastAPI(title="Moodify API Gateway")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def log_telemetry(request: Request, call_next):
    start_time = time.perf_counter()
    response = await call_next(request)
    process_time = (time.perf_counter() - start_time) * 1000
    print(f"[TELEMETRY] Method: {request.method} | Path: {request.url.path} | Status: {response.status_code} | Latency: {process_time:.2f}ms")
    response.headers["X-Process-Time-Ms"] = str(round(process_time, 2))
    return response

@app.get("/")
def health_check():
    return {"status": "online", "service": "Moodify API Gateway v1.0"}

@app.get("/login")
def login():
    state_token = secrets.token_urlsafe(16)
    auth_url = sp_oauth.get_authorize_url(state=state_token)
    return RedirectResponse(url=auth_url)

@app.get("/callback")
def callback(code: str):
    try:
        token_info = sp_oauth.get_access_token(code, check_cache=False)
        access_token = token_info['access_token']
        return RedirectResponse(url=f"{FRONTEND_URL}?token={access_token}")
    except Exception as e:
        return RedirectResponse(url=f"{FRONTEND_URL}?auth=error")

EMOTION_TAXONOMY = {
    "energetic": ("High Energy Hype", "Energy Mix"),
    "energy": ("High Energy Hype", "Energy Mix"),
    "hyped": ("Workout Hype", "Workout Energy"),
    "workout": ("Gym Motivation", "Workout"),
    "angry": ("Aggressive Catharsis", "Rage"),
    "confident": ("Triumphant Confidence", "Confidence Boost"),
    "happy": ("Sunlit Euphoria", "Happy Hits"),
    "joyful": ("Pure Joy", "Feel Good Pop"),
    "excited": ("Euphoric Rush", "Party Hits"),
    "motivated": ("Unstoppable Drive", "Motivation"),
    "chill": ("Relaxed Lo-Fi", "Chill Vibes"),
    "relaxed": ("Peaceful Serenity", "Peaceful Piano"),
    "sleepy": ("Deep Sleep Ambient", "Sleep Lofi"),
    "study": ("Focus & Concentration", "Deep Focus"),
    "peaceful": ("Tranquil Meditation", "Ambient Chill"),
    "sad": ("Melancholic Reflection", "Sad Acoustic"),
    "lonely": ("Late Night Solitude", "Night Rain"),
    "heartbroken": ("Heartbreak & Catharsis", "Broken Heart"),
    "nostalgic": ("Nostalgic Memories", "Nostalgia Hits"),
    "anxious": ("Calming Grounding", "Stress Relief")
}

@app.post("/api/mood")
async def process_mood(payload: dict):
    user_prompt = payload.get("prompt", "Chill vibes").strip()
    user_prompt_lower = user_prompt.lower()
    
    derived_mood = "Custom Vibe Mix"
    playlist_query = user_prompt
    track_search_queries = [user_prompt]

    # 1. AI Emotional Deciphering via Gemini (using active model gemini-1.5-flash)
    if genai_client:
        try:
            response = genai_client.models.generate_content(
                model='gemini-1.5-flash',
                contents=f"""
                You are an emotional intelligence & musicology expert.
                Deconstruct this user prompt: "{user_prompt}"

                Understand the underlying human emotion (e.g., Nostalgia, Heartbreak, Catharsis, High Energy, Euphoria, Serenity).

                Return a JSON object with strictly three keys:
                1. "derived_mood": A poetic title for this mood (3-4 words max).
                2. "playlist_query": A 1-2 word query that matches real Spotify public playlists.
                3. "search_keywords": An array of 3 song/vibe keywords to search individual tracks directly.

                Return ONLY valid JSON without markdown formatting.
                """
            )
            raw_text = response.text.strip().replace("```json", "").replace("```", "").strip()
            ai_data = json.loads(raw_text)
            derived_mood = ai_data.get("derived_mood", "Dynamic Vibe Mix")
            playlist_query = ai_data.get("playlist_query", user_prompt)
            track_search_queries = ai_data.get("search_keywords", [playlist_query])
        except Exception as e:
            print(f"[WARNING] Gemini parsing fallback: {str(e)}")
            if user_prompt_lower in EMOTION_TAXONOMY:
                derived_mood, playlist_query = EMOTION_TAXONOMY[user_prompt_lower]
                track_search_queries = [playlist_query]

    sp_search = spotipy.Spotify(auth_manager=SpotifyClientCredentials(
        client_id=SPOTIFY_CLIENT_ID,
        client_secret=SPOTIFY_CLIENT_SECRET
    ))

    existing_playlists = []
    recommended_tracks = []
    seen_track_ids = set()

    try:
        # 2. Search Spotify Public Playlists (Returns only organic matches, e.g. 2 if only 2 exist)
        playlist_results = sp_search.search(q=playlist_query, type='playlist', limit=6)
        playlists_obj = playlist_results.get('playlists') if isinstance(playlist_results, dict) else None
        playlists = playlists_obj.get('items', []) if isinstance(playlists_obj, dict) and playlists_obj.get('items') else []

        for playlist in playlists:
            if not playlist or not isinstance(playlist, dict):
                continue
            
            images = playlist.get('images') or []
            cover_url = images[0].get('url', '') if (isinstance(images, list) and len(images) > 0 and isinstance(images[0], dict)) else ""
            
            tracks_obj = playlist.get('tracks', {})
            tracks_count = tracks_obj.get('total', 0) if isinstance(tracks_obj, dict) else 0

            owner_obj = playlist.get('owner', {})
            owner_name = owner_obj.get('display_name', 'Spotify') if isinstance(owner_obj, dict) else 'Spotify'

            ext_urls = playlist.get('external_urls', {})
            external_url = ext_urls.get('spotify', '#') if isinstance(ext_urls, dict) else '#'

            existing_playlists.append({
                "title": playlist.get('name', 'Curated Playlist'),
                "owner": owner_name,
                "tracks_count": tracks_count,
                "external_url": external_url,
                "spotify_uri": playlist.get('uri', ''),
                "cover_image": cover_url
            })

        # 3. Direct Track Search (Fixes 403 Forbidden errors)
        for term in track_search_queries[:3]:
            track_results = sp_search.search(q=term, type='track', limit=4)
            tracks_obj = track_results.get('tracks', {}) if isinstance(track_results, dict) else {}
            items = tracks_obj.get('items', []) if isinstance(tracks_obj, dict) else []

            for track in items:
                if not track or not isinstance(track, dict) or not track.get('id') or track['id'] in seen_track_ids:
                    continue
                seen_track_ids.add(track['id'])
                artists = track.get('artists', [])
                artist_name = artists[0].get('name', 'Unknown Artist') if (artists and isinstance(artists[0], dict)) else "Unknown Artist"

                recommended_tracks.append({
                    "title": track.get('name', 'Untitled Track'),
                    "artist": artist_name,
                    "external_url": track.get('external_urls', {}).get('spotify', '#'),
                    "spotify_uri": track.get('uri', ''),
                    "popularity": track.get('popularity', 0)
                })

        recommended_tracks.sort(key=lambda x: x.get('popularity', 0), reverse=True)
        recommended_tracks = recommended_tracks[:8]

    except Exception as e:
        print(f"[ERROR] Spotify Search Error: {str(e)}")

    return {
        "status": "success",
        "input_prompt": user_prompt,
        "derived_mood": derived_mood,
        "existing_playlists": existing_playlists,
        "recommended_tracks": recommended_tracks
    }

@app.post("/api/create-playlist")
async def create_playlist(payload: dict, authorization: str = Header(None)):
    playlist_title = payload.get("title", "Moodify Custom Playlist")
    track_uris = payload.get("track_uris", [])

    if not track_uris:
        raise HTTPException(status_code=400, detail="No track URIs provided.")

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid authorization token.")

    token = authorization.split("Bearer ")[1]

    try:
        sp_user = spotipy.Spotify(auth=token)
        user_profile = sp_user.current_user()
        user_id = user_profile['id']

        new_playlist = sp_user.user_playlist_create(
            user=user_id,
            name=f"Moodify: {playlist_title}",
            public=True,
            description="Generated by Moodify AI Music Curation."
        )

        sp_user.playlist_add_items(playlist_id=new_playlist['id'], items=track_uris)

        return {
            "status": "success",
            "playlist_name": new_playlist['name'],
            "playlist_url": new_playlist['external_urls']['spotify']
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create playlist: {str(e)}")

@app.get("/api/me")
def get_user_profile(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing authorization token")

    token = authorization.split("Bearer ")[1]
    try:
        sp_user = spotipy.Spotify(auth=token)
        profile = sp_user.current_user()
        images = profile.get('images', [])
        avatar_url = images[0].get('url', '') if images else ""
        return {
            "status": "success",
            "display_name": profile.get('display_name', profile.get('id', 'Spotify User')),
            "avatar": avatar_url
        }
    except Exception as e:
        raise HTTPException(status_code=401, detail="Token invalid or expired")

@app.get("/api/logout")
def logout():
    return {"status": "success", "message": "Logged out successfully"}