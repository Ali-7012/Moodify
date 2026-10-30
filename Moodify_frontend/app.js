const API_BASE_URL = "https://moodify-a605.onrender.com";
const token = sessionStorage.getItem('spotify_token');

const response = await fetch(`${API_BASE_URL}/api/me`, {
    headers: {
        'Authorization': `Bearer ${token}`
    }
});
let currentTrackUris = [];
let currentDerivedMood = "";

window.addEventListener('DOMContentLoaded', checkUserAuth);

function linkSpotify() {
    window.location.href = `${API_BASE_URL}/login`;
}

// 1. Helper function to reset UI back to logged-out state
function showLoginButton() {
    const authContainer = document.getElementById('authContainer');
    if (!authContainer) return;
    
    authContainer.innerHTML = `
        <button onclick="linkSpotify()" class="group relative flex items-center space-x-2 px-5 py-2.5 bg-slate-900 hover:bg-slate-800 border border-slate-700 hover:border-slate-600 rounded-full shadow-md overflow-hidden transition-all duration-300">
            <div class="absolute inset-0 opacity-0 group-hover:opacity-100 bg-gradient-to-tr from-transparent via-white/10 to-transparent pointer-events-none transition-opacity duration-300"></div>
            <img src="Spotify.png" alt="Spotify" class="w-6 h-6 z-10 object-contain drop-shadow-md">
            <span class="text-white font-bold text-xs uppercase tracking-wider z-10 relative">Link Spotify</span>
        </button>
    `;
}

// 2. Updated checkUserAuth with 401 handling
async function checkUserAuth() {
    const authContainer = document.getElementById('authContainer');
    if (!authContainer) return;

    try {
        const response = await fetch(`${API_BASE_URL}/api/me`);
        
        // If unauthenticated or token expired, force UI reset
        if (!response.ok || response.status === 401) {
            showLoginButton();
            return;
        }

        const user = await response.json();
        
        if (user.status === 'success') {
            const avatarHtml = user.avatar 
                ? `<img src="${user.avatar}" class="w-6 h-6 rounded-full object-cover border border-green-500">`
                : `<div class="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center text-black font-bold text-xs">🎵</div>`;

            authContainer.innerHTML = `
                <div class="flex items-center gap-2.5 bg-slate-900/80 border border-green-500/40 px-3 py-1.5 rounded-full shadow-sm">
                    ${avatarHtml}
                    <span class="text-xs font-semibold text-white max-w-[100px] truncate">${user.display_name}</span>
                    <span class="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
                    <button onclick="logout()" class="text-xs text-slate-400 hover:text-red-400 font-semibold ml-1 transition">
                        Logout
                    </button>
                </div>
            `;
        }
    } catch (err) {
        showLoginButton();
    }
}
async function logout() {
    try {
        await fetch(`${API_BASE_URL}/api/logout`);
        // Refresh page back to clean view
        window.location.href = window.location.pathname;
    } catch (err) {
        console.error("Logout failed", err);
    }
}

async function generatePlaylist() {
    const prompt = document.getElementById('moodPrompt').value;
    const btn = document.getElementById('submitBtn');
    const resultsDiv = document.getElementById('results');
    const existingPlaylistsList = document.getElementById('existingPlaylistsList');
    const trackList = document.getElementById('trackList');
    const moodOutput = document.getElementById('moodOutput');

    if (!prompt) return alert('Please enter how you feel!');

    btn.innerText = 'Curating music...';
    btn.disabled = true;

    try {
        const response = await fetch(`${API_BASE_URL}/api/mood`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt })
        });

        const data = await response.json();
        
        currentDerivedMood = data.derived_mood;
        moodOutput.innerText = currentDerivedMood;
        
        // 1. Render Existing Playlists (Section 1)
        existingPlaylistsList.innerHTML = '';
        if (data.existing_playlists && data.existing_playlists.length > 0) {
            data.existing_playlists.forEach(pl => {
                const imgTag = pl.cover_image 
                    ? `<img src="${pl.cover_image}" class="w-12 h-12 rounded object-cover mr-3 flex-shrink-0">`
                    : `<div class="w-12 h-12 rounded bg-slate-800 flex items-center justify-center mr-3 flex-shrink-0 text-slate-500 text-xs">🎵</div>`;

                const trackCountText = (pl.tracks_count && pl.tracks_count > 0) 
                    ? ` • ${pl.tracks_count} tracks` 
                    : '';

                const plCard = `
                    <div class="flex items-center justify-between bg-slate-950 p-3 rounded-lg border border-slate-800 hover:border-slate-700 transition">
                        <div class="flex items-center overflow-hidden mr-2">
                            ${imgTag}
                            <div class="truncate">
                                <p class="font-semibold text-white text-sm truncate">${pl.title}</p>
                                <p class="text-xs text-slate-400">By ${pl.owner}${trackCountText}</p>
                            </div>
                        </div>
                        <a href="${pl.spotify_uri || pl.external_url}" target="_blank" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded border border-slate-700 transition whitespace-nowrap">
                            Open Playlist
                        </a>
                    </div>
                `;
                existingPlaylistsList.innerHTML += plCard;
            });
        } else {
            existingPlaylistsList.innerHTML = `<p class="text-xs text-slate-500">No existing playlists found for this mood.</p>`;
        }

        // 2. Render Custom Track Mix (Section 2)
        trackList.innerHTML = '';
        currentTrackUris = [];

        if (data.recommended_tracks && data.recommended_tracks.length > 0) {
            data.recommended_tracks.forEach(track => {
                if (track.spotify_uri) {
                    currentTrackUris.push(track.spotify_uri);
                }
                
                const trackCard = `
                    <div class="flex items-center justify-between bg-slate-950 p-3 rounded-lg border border-slate-800">
                        <div class="truncate mr-2">
                            <p class="font-semibold text-white text-sm truncate">${track.title}</p>
                            <p class="text-xs text-slate-400 truncate">${track.artist}</p>
                        </div>
                        <a href="${track.spotify_uri}" target="_blank" class="px-3 py-1.5 bg-green-500/10 hover:bg-green-500/20 text-green-400 text-xs font-semibold rounded border border-green-500/30 transition whitespace-nowrap">
                            Open Song
                        </a>
                    </div>
                `;
                trackList.innerHTML += trackCard;
            });
        }

        resultsDiv.classList.remove('hidden');
    } catch (err) {
        alert('Failed to connect to backend server. Make sure FastAPI is running on port 8000.');
        console.error(err);
    } finally {
        btn.innerText = 'Generate Playlist';
        btn.disabled = false;
    }
}

window.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');

    if (token) {
        sessionStorage.setItem('spotify_token', token);
        // Clean URL parameter
        window.history.replaceState({}, document.title, window.location.pathname);
    }

    checkUserAuth();
});

async function saveToSpotify() {
    const saveBtn = document.getElementById('saveBtn');
    if (currentTrackUris.length === 0) return alert('No tracks to save!');

    saveBtn.innerText = 'Saving...';
    saveBtn.disabled = true;

    try {
        const response = await fetch(`${API_BASE_URL}/api/create-playlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: currentDerivedMood,
                track_uris: currentTrackUris
            })
        });

        const data = await response.json();

        if (response.ok) {
            alert(`Success! Created "${data.playlist_name}" in your Spotify library.`);
            window.open(data.playlist_url, '_blank');
        } else {
            alert(data.detail || 'Failed to create playlist. Click "Link Spotify" first.');
        }
    } catch (err) {
        alert('Error creating playlist. Make sure you are logged in.');
        console.error(err);
    } finally {
        saveBtn.innerText = 'Save to Spotify';
        saveBtn.disabled = false;
    }
}