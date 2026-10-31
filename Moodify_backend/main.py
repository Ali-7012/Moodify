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

sp_oauth = SpotifyOAuth(
    client_id=SPOTIFY_CLIENT_ID,
    client_secret=SPOTIFY_CLIENT_SECRET,
    redirect_uri=SPOTIFY_REDIRECT_URI,
    scope="playlist-modify-public playlist-modify-private user-read-private",
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
    "energetic": ("Energetic Hype", "Energy Mix"),
    "chill": ("Chill Vibes", "Chill Lofi"),
    "happy": ("Happy Beats", "Happy Hits"),
    "sad": ("Sad Songs", "Sad Acoustic"),
    "workout": ("Workout Energy", "Gym Motivation")
}

@app.post("/api/mood")
async def process_mood(payload: dict):
    user_prompt = payload.get("prompt", "Chill vibes").strip()
    user_prompt_lower = user_prompt.lower()
    
    prompt_words = user_prompt.split()
    safe_title = " ".join(prompt_words[:3]).title() if len(prompt_words) > 3 else user_prompt.title()

    derived_mood = safe_title
    playlist_query = safe_title
    track_search_queries = [safe_title]

    # 1. AI Emotional Deciphering via Active Gemini Models
    if genai_client:
        ai_response_text = None
        candidate_models = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash']

        for model_name in candidate_models:
            try:
                response = genai_client.models.generate_content(
                    model=model_name,
                    contents=f"""
                    You are an expert musicologist and emotion analyst.
                    Deconstruct this user mood prompt: "{user_prompt}"

                    Task:
                    1. "derived_mood": Create a short, poetic playlist title (STRICTLY 2 TO 4 WORDS MAX).
                    2. "playlist_query": 1 to 2 concise words to search real public Spotify playlists.
                    3. "search_keywords": Array of 3 short search terms (1-2 words each) to query tracks on Spotify directly.

                    Return ONLY raw valid JSON matching this schema without markdown code block formatting:
                    {{
                      "derived_mood": "...",
                      "playlist_query": "...",
                      "search_keywords": ["...", "...", "..."]
                    }}
                    """
                )
                if response and response.text:
                    ai_response_text = response.text.strip().replace("```json", "").replace("```", "").strip()
                    if ai_response_text:
                        break  # Stop loop as soon as an active model succeeds
            except Exception as e:
                print(f"[WARNING] Gemini model '{model_name}' failed/unavailable ({str(e)}). Trying next candidate...")

        if ai_response_text:
            try:
                ai_data = json.loads(ai_response_text)
                
                raw_mood = ai_data.get("derived_mood", safe_title)
                mood_words = str(raw_mood).strip().split()
                derived_mood = " ".join(mood_words[:4]).title()

                raw_pl_query = ai_data.get("playlist_query", safe_title)
                pl_words = str(raw_pl_query).strip().split()
                playlist_query = " ".join(pl_words[:2])

                raw_keywords = ai_data.get("search_keywords", [playlist_query])
                if isinstance(raw_keywords, list) and len(raw_keywords) > 0:
                    track_search_queries = [str(k).strip() for k in raw_keywords if k]
            except Exception as parse_err:
                print(f"[WARNING] Gemini JSON parsing failed: {str(parse_err)}")

    if not track_search_queries and user_prompt_lower in EMOTION_TAXONOMY:
        derived_mood, playlist_query = EMOTION_TAXONOMY[user_prompt_lower]
        track_search_queries = [playlist_query]

    sp_search = spotipy.Spotify(auth_manager=SpotifyClientCredentials(
        client_id=SPOTIFY_CLIENT_ID,
        client_secret=SPOTIFY_CLIENT_SECRET
    ))

    existing_playlists = []
    recommended_tracks = []
    seen_track_ids = set()

    # 2. Search Organic Public Playlists
    try:
        playlist_results = sp_search.search(q=str(playlist_query), type='playlist', limit=6)
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
    except Exception as pl_err:
        print(f"[WARNING] Public playlist search error: {str(pl_err)}")

    # 3. Direct Track Gathering (Early Exit Optimization)
    for term in track_search_queries:
        if len(recommended_tracks) >= 10:
            break
        if not term:
            continue
        try:
            track_results = sp_search.search(q=str(term), type='track', limit=10)
            tracks_obj = track_results.get('tracks', {}) if isinstance(track_results, dict) else {}
            items = tracks_obj.get('items', []) if isinstance(tracks_obj, dict) else []

            for track in items:
                if not track or not isinstance(track, dict) or not track.get('id') or track['id'] in seen_track_ids:
                    continue
                seen_track_ids.add(track['id'])

                recommended_tracks.append({
                    "title": track.get('name', 'Untitled Track'),
                    "spotify_uri": track.get('uri', ''),
                    "popularity": track.get('popularity', 0)
                })
                if len(recommended_tracks) >= 10:
                    break
        except Exception as t_err:
            print(f"[WARNING] Track search failed for '{term}': {str(t_err)}")

    # 4. Fallback: Guarantee 10 tracks
    if len(recommended_tracks) < 10:
        try:
            fallback_results = sp_search.search(q=str(playlist_query), type='track', limit=20)
            tracks_obj = fallback_results.get('tracks', {}) if isinstance(fallback_results, dict) else {}
            items = tracks_obj.get('items', []) if isinstance(tracks_obj, dict) else []

            for track in items:
                if not track or not isinstance(track, dict) or not track.get('id') or track['id'] in seen_track_ids:
                    continue
                seen_track_ids.add(track['id'])

                recommended_tracks.append({
                    "title": track.get('name', 'Untitled Track'),
                    "spotify_uri": track.get('uri', ''),
                    "popularity": track.get('popularity', 0)
                })
                if len(recommended_tracks) >= 10:
                    break
        except Exception as f_err:
            print(f"[WARNING] Fallback search failed: {str(f_err)}")

    recommended_tracks.sort(key=lambda x: x.get('popularity', 0), reverse=True)
    recommended_tracks = recommended_tracks[:10]

    return {
        "status": "success",
        "input_prompt": user_prompt,
        "derived_mood": derived_mood,
        "existing_playlists": existing_playlists,
        "recommended_tracks": recommended_tracks
    }

@app.post("/api/create-playlist")
async def create_playlist(payload: dict, authorization: str = Header(None)):
    playlist_title = payload.get("title", "Moodify Mix")
    track_uris = payload.get("track_uris", [])

    if not track_uris:
        raise HTTPException(status_code=400, detail="No tracks available to create playlist.")

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid authorization token.")

    token = authorization.split("Bearer ")[1]

    try:
        sp_user = spotipy.Spotify(auth=token)
        new_playlist = sp_user.current_user_playlist_create(
            name=playlist_title,
            public=True,
            description="Curated by Moodify AI based on your emotion."
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