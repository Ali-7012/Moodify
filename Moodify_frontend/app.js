"use strict";

// Running the page from Live Server (127.0.0.1 / localhost) talks to a local backend on port 8000.
const IS_LOCAL = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const API_BASE_URL = IS_LOCAL ? "http://127.0.0.1:8000" : "https://moodify-a605.onrender.com";

// Render's free tier can take a while to wake up, so allow a generous timeout.
const REQUEST_TIMEOUT_MS = 25000;
const TOKEN_KEY = "spotify_token";

const state = {
    trackUris: [],
    mixTitle: "",
    generating: false,
    saving: false,
    saved: false,
};

const $ = (id) => document.getElementById(id);

/* ---------- Small helpers ---------- */

// Builds DOM nodes without innerHTML, so text from Spotify can never become markup.
function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === "class") node.className = value;
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key in node) node[key] = value;
        else node.setAttribute(key, value);
    }
    node.append(...children.filter((c) => c !== null && c !== undefined));
    return node;
}

// Only allow https links/images (blocks javascript:, data:, etc.).
function safeHttpsUrl(value) {
    if (typeof value !== "string" || !value) return "";
    try {
        const url = new URL(value);
        return url.protocol === "https:" ? url.href : "";
    } catch {
        return "";
    }
}

function setStatus(id, kind, ...nodes) {
    const box = $(id);
    box.classList.toggle("is-error", kind === "error");
    box.replaceChildren(...nodes);
}

class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

async function api(path, { method = "GET", body, token } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
        response = await fetch(`${API_BASE_URL}${path}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (err) {
        const message = err && err.name === "TimeoutError"
            ? "The server is taking too long. It may be waking up, so try again in a few seconds."
            : "Couldn't reach the server. Check your connection and try again.";
        throw new ApiError(message, 0);
    }

    let data = null;
    try {
        data = await response.json();
    } catch {
        data = null;
    }

    if (!response.ok) {
        const detail = data && typeof data.detail === "string"
            ? data.detail
            : "Something went wrong. Try again.";
        throw new ApiError(detail, response.status);
    }
    return data;
}

/* ---------- Auth ---------- */

// The backend sends the token back in the URL fragment (#token=...), which never reaches
// any server or log. ?token= is still read so older backend versions keep working.
function readAuthFromUrl() {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const query = new URLSearchParams(window.location.search);
    const token = hash.get("token") || query.get("token");
    const authError = (hash.get("auth") || query.get("auth")) === "error";

    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    if (token || authError || window.location.hash) {
        window.history.replaceState(null, "", window.location.pathname);
    }
    return authError;
}

function startLogin() {
    window.location.href = `${API_BASE_URL}/login`;
}

function logout() {
    sessionStorage.removeItem(TOKEN_KEY);
    renderLoggedOut();
}

function renderLoggedOut() {
    const button = el("button", { type: "button", class: "btn btn-ghost" },
        el("img", { src: "Spotify.png", alt: "", width: 18, height: 18 }),
        "Link Spotify",
    );
    button.addEventListener("click", startLogin);
    $("authContainer").replaceChildren(button);
}

function renderLoggedIn(user) {
    const name = typeof user.display_name === "string" && user.display_name.trim()
        ? user.display_name.trim()
        : "Spotify user";
    const avatarUrl = safeHttpsUrl(user.avatar);

    const avatar = avatarUrl
        ? el("img", { src: avatarUrl, alt: "", class: "avatar", width: 28, height: 28 })
        : el("span", { class: "avatar", "aria-hidden": "true" }, name.charAt(0).toUpperCase());

    const logoutButton = el("button", { type: "button", class: "link-button" }, "Log out");
    logoutButton.addEventListener("click", logout);

    $("authContainer").replaceChildren(
        el("div", { class: "user" },
            avatar,
            el("span", { class: "user-name", title: name }, name),
            logoutButton,
        ),
    );
}

async function checkUserAuth() {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) {
        renderLoggedOut();
        return;
    }
    try {
        const user = await api("/api/me", { token });
        renderLoggedIn(user);
    } catch (err) {
        if (err.status === 401) sessionStorage.removeItem(TOKEN_KEY);
        renderLoggedOut();
    }
}

/* ---------- Generate ---------- */

function setGenerating(isBusy) {
    state.generating = isBusy;
    const button = $("submitBtn");
    button.disabled = isBusy;
    button.textContent = isBusy ? "Finding music…" : "Find music";
    document.body.classList.toggle("is-loading", isBusy);
    document.body.setAttribute("aria-busy", String(isBusy));
}

async function generatePlaylist(event) {
    if (event) event.preventDefault();
    if (state.generating) return;

    const input = $("moodPrompt");
    const prompt = input.value.trim();
    if (!prompt) {
        setStatus("status", "error", "Type how you feel first.");
        input.focus();
        return;
    }

    setGenerating(true);
    setStatus("status", "info");

    try {
        const data = await api("/api/mood", { method: "POST", body: { prompt } });
        renderResults(data);
    } catch (err) {
        setStatus("status", "error", err.message);
    } finally {
        setGenerating(false);
    }
}

function renderResults(data) {
    const tracks = Array.isArray(data.recommended_tracks) ? data.recommended_tracks : [];
    state.trackUris = tracks
        .map((t) => t && t.spotify_uri)
        .filter((uri) => typeof uri === "string" && uri.startsWith("spotify:track:"));
    state.mixTitle = typeof data.derived_mood === "string" && data.derived_mood.trim()
        ? data.derived_mood.trim()
        : "Moodify Mix";
    state.saved = false;

    $("moodOutput").textContent = state.mixTitle;

    const count = state.trackUris.length;
    $("mixMeta").textContent = count
        ? `${count} ${count === 1 ? "track" : "tracks"}, ready to save.`
        : "No tracks matched this mood. Try describing it differently.";

    const saveButton = $("saveBtn");
    saveButton.disabled = count === 0;
    saveButton.textContent = "Save to my Spotify";
    setStatus("saveStatus", "info");

    renderPlaylists(Array.isArray(data.existing_playlists) ? data.existing_playlists : []);

    const results = $("results");
    results.hidden = false;
    results.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

function renderPlaylists(playlists) {
    const list = $("existingPlaylistsList");
    const items = playlists
        .filter((pl) => pl && typeof pl === "object")
        .map((pl) => {
            const title = typeof pl.title === "string" && pl.title ? pl.title : "Untitled playlist";
            const owner = typeof pl.owner === "string" && pl.owner ? pl.owner : "Spotify";
            const total = Number.isFinite(pl.tracks_count) && pl.tracks_count > 0 ? pl.tracks_count : 0;
            const coverUrl = safeHttpsUrl(pl.cover_image);
            const openUrl = safeHttpsUrl(pl.external_url);

            const cover = coverUrl
                ? el("img", { src: coverUrl, alt: "", class: "cover", width: 56, height: 56, loading: "lazy" })
                : el("div", { class: "cover", "aria-hidden": "true" });

            const meta = total ? `by ${owner}, ${total} tracks` : `by ${owner}`;

            return el("li", { class: "playlist" },
                cover,
                el("div", { class: "playlist-text" },
                    el("p", { class: "playlist-name", title }, title),
                    el("p", { class: "playlist-meta" }, meta),
                ),
                openUrl
                    ? el("a", {
                        class: "playlist-open",
                        href: openUrl,
                        target: "_blank",
                        rel: "noopener noreferrer",
                        "aria-label": `Open ${title} on Spotify`,
                    }, "Open")
                    : null,
            );
        });

    if (items.length === 0) {
        list.replaceChildren(el("li", { class: "empty" }, "No public playlists found for this mood."));
    } else {
        list.replaceChildren(...items);
    }
}

/* ---------- Save ---------- */

async function saveToSpotify() {
    if (state.saving || state.saved) return;

    if (state.trackUris.length === 0) {
        setStatus("saveStatus", "error", "There are no tracks to save yet.");
        return;
    }

    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) {
        const loginLink = el("button", { type: "button", class: "link-button" }, "Link Spotify");
        loginLink.addEventListener("click", startLogin);
        setStatus("saveStatus", "error", "Link your Spotify account first. ", loginLink);
        return;
    }

    const saveButton = $("saveBtn");
    state.saving = true;
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";
    setStatus("saveStatus", "info");

    try {
        const data = await api("/api/create-playlist", {
            method: "POST",
            token,
            body: { title: state.mixTitle, track_uris: state.trackUris },
        });

        state.saved = true;
        saveButton.textContent = "Saved";

        const added = Number.isFinite(data.tracks_added) ? data.tracks_added : state.trackUris.length;
        $("mixMeta").textContent = `${added} ${added === 1 ? "track" : "tracks"}, saved to your library.`;
        const name = typeof data.playlist_name === "string" ? data.playlist_name : state.mixTitle;
        const link = safeHttpsUrl(data.playlist_url);

        setStatus("saveStatus", "info",
            `Saved "${name}" with ${added} ${added === 1 ? "track" : "tracks"}. `,
            link ? el("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, "Open in Spotify") : "",
        );
    } catch (err) {
        if (err.status === 401) {
            sessionStorage.removeItem(TOKEN_KEY);
            renderLoggedOut();
        }
        setStatus("saveStatus", "error", err.message);
    } finally {
        state.saving = false;
        if (!state.saved) {
            saveButton.disabled = false;
            saveButton.textContent = "Save to my Spotify";
        }
    }
}

/* ---------- Open Spotify links in the Spotify app ---------- */

const UA = navigator.userAgent || "";
const IS_IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(UA);
const SPOTIFY_TYPES = new Set(["playlist", "track", "album", "artist", "show", "episode"]);

// "https://open.spotify.com/intl-en/playlist/ID?si=..." -> { type: "playlist", id: "ID", web: clean web URL }
function parseSpotifyWebUrl(href) {
    let url;
    try {
        url = new URL(href);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" || url.hostname !== "open.spotify.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const i = parts.findIndex((p) => SPOTIFY_TYPES.has(p));
    if (i === -1 || !/^[A-Za-z0-9]+$/.test(parts[i + 1] || "")) return null;
    return { type: parts[i], id: parts[i + 1], web: `https://open.spotify.com/${parts[i]}/${parts[i + 1]}` };
}

// The address that opens the installed app on this platform.
function appLaunchUrl(target, platform) {
    if (platform === "android") {
        // Opens the app if installed, otherwise Chrome falls back to the web link.
        return `intent://${target.type}/${target.id}#Intent;scheme=spotify;package=com.spotify.music;`
            + `S.browser_fallback_url=${encodeURIComponent(target.web)};end`;
    }
    return `spotify:${target.type}:${target.id}`; // desktop: browser asks "Open Spotify?"
}

function showWebFallback(link, webUrl) {
    const container = link.closest(".playlist")?.querySelector(".playlist-text")
        || link.closest(".status")
        || $("status");
    if (!container || container.querySelector(".open-hint")) return;
    container.append(
        el("span", { class: "open-hint" },
            "Spotify app didn't open? ",
            el("a", { href: webUrl, target: "_blank", rel: "noopener noreferrer", dataset: { webOnly: "" } },
                "Open it in your browser"),
        ),
    );
}

function handleSpotifyLinkClick(event) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href^="https://open.spotify.com/"]');
    if (!link || "webOnly" in link.dataset) return;
    const target = parseSpotifyWebUrl(link.href);
    if (!target) return;

    // iPhone/iPad: open.spotify.com is a Universal Link, so iOS already opens the app when installed.
    if (IS_IOS) return;

    event.preventDefault();

    if (IS_ANDROID) {
        window.location.href = appLaunchUrl(target, "android");
        return;
    }

    // Desktop: try the app. If the window never loses focus, the app probably isn't installed,
    // so offer the web link instead of leaving the user wondering.
    let appOpened = false;
    const onLeave = () => { appOpened = true; };
    window.addEventListener("blur", onLeave, { once: true });
    document.addEventListener("visibilitychange", onLeave, { once: true });
    window.location.href = appLaunchUrl(target, "desktop");
    setTimeout(() => {
        window.removeEventListener("blur", onLeave);
        document.removeEventListener("visibilitychange", onLeave);
        if (!appOpened) showWebFallback(link, target.web);
    }, 1500);
}

/* ---------- Wire up ---------- */

function init() {
    const authFailed = readAuthFromUrl();
    if (authFailed) {
        setStatus("status", "error", "Spotify sign-in didn't finish. Try linking your account again.");
    }

    // The static login button in the HTML works even before /api/me answers.
    document.querySelectorAll('[data-action="login"]').forEach((b) => b.addEventListener("click", startLogin));

    $("moodForm").addEventListener("submit", generatePlaylist);
    $("saveBtn").addEventListener("click", saveToSpotify);
    document.addEventListener("click", handleSpotifyLinkClick);

    document.querySelectorAll(".example").forEach((button) => {
        button.addEventListener("click", () => {
            $("moodPrompt").value = button.textContent.trim();
            generatePlaylist();
        });
    });

    checkUserAuth();
}

init();
