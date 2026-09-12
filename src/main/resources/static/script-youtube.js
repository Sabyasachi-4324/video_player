let stompClient = null;
let currentRoom = "";
let username = "";
let hasJoined = false;
let amIHost = false;
let currentOwner = "";
let isRemoteUpdate = false;
let roomUsers = [];
let reconnectTimer = null;
let isConnecting = false;
let isLeavingPage = false;
const roomMode = 'youtube';
const roomPrefix = roomMode + ':';

// YouTube API Variables
let ytPlayer = null;
let isYtApiReady = false;
let currentVideoId = "";

const blocker = document.getElementById('blocker');
const statusDot = document.getElementById('status-dot');
const lockBtn = document.getElementById('lockBtn');
const chatInput = document.getElementById('chatInput');
const notifSound = new Audio("https://codeskulptor-demos.commondatastorage.googleapis.com/pang/pop.mp3");
statusDot.classList.toggle('online', navigator.onLine);
statusDot.classList.toggle('offline', !navigator.onLine);

// Independent camera and microphone streams
let localCamStream = null;
let localMicStream = null;
let isMicMuted = false;
const mediaPeerConnections = {};
const pendingMediaIceCandidates = {};
const remoteMediaStreams = {};
const remoteAudioElements = {};
const mediaRtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const camWrapper = document.getElementById('floating-cam-wrapper');
let isCamDragging = false;
let camDragStartX = 0;
let camDragStartY = 0;
let camOffsetX = 0;
let camOffsetY = 0;

camWrapper.addEventListener('pointerdown', event => {
    if (event.target.closest('.cam-btn')) return;
    isCamDragging = true;
    camDragStartX = event.clientX - camOffsetX;
    camDragStartY = event.clientY - camOffsetY;
    camWrapper.setPointerCapture(event.pointerId);
    camWrapper.classList.add('dragging');
});

camWrapper.addEventListener('pointermove', event => {
    if (!isCamDragging) return;
    const parentRect = document.getElementById('video-wrapper').getBoundingClientRect();
    const currentRect = camWrapper.getBoundingClientRect();
    const left = Math.min(parentRect.width - currentRect.width, Math.max(0, currentRect.left - parentRect.left + event.movementX));
    const top = Math.min(parentRect.height - currentRect.height, Math.max(0, currentRect.top - parentRect.top + event.movementY));
    camOffsetX += left - (currentRect.left - parentRect.left);
    camOffsetY += top - (currentRect.top - parentRect.top);
    camWrapper.style.transform = `translate(${camOffsetX}px, ${camOffsetY}px)`;
});

camWrapper.addEventListener('pointerup', event => {
    isCamDragging = false;
    camWrapper.releasePointerCapture(event.pointerId);
    camWrapper.classList.remove('dragging');
});

camWrapper.addEventListener('pointercancel', () => {
    isCamDragging = false;
    camWrapper.classList.remove('dragging');
});

const savedRoom = sessionStorage.getItem('syncPlayerRoom:' + roomMode);
const savedUsername = sessionStorage.getItem('syncPlayerUsername:' + roomMode);
if (savedRoom && savedUsername) {
    document.getElementById('username').value = savedUsername;
    document.getElementById('roomId').value = savedRoom;
    setTimeout(() => enterRoom(false), 0);
}

// --- 1. LOAD YOUTUBE API ---
function loadYouTubeAPI() {
    const tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
}
// This function is automatically called by the YouTube API once it loads
window.onYouTubeIframeAPIReady = function() {
    isYtApiReady = true;
};
loadYouTubeAPI();

// Extract IDs from watch, short, embed, live, and youtu.be links.
function extractVideoID(value) {
    const input = value.trim();
    if (/^[\w-]{11}$/.test(input)) return input;

    try {
        const url = new URL(input);
        const host = url.hostname.replace(/^www\./, '');
        if (host === 'youtu.be') {
            const videoId = url.pathname.slice(1).split('/')[0];
            return /^[\w-]{11}$/.test(videoId) ? videoId : false;
        }
        if (host !== 'youtube.com' && host !== 'm.youtube.com') return false;

        const pathParts = url.pathname.split('/').filter(Boolean);
        const pathIndex = ['embed', 'shorts', 'live', 'v'].indexOf(pathParts[0]);
        const videoId = pathIndex >= 0 ? pathParts[1] : url.searchParams.get('v');
        return videoId && /^[\w-]{11}$/.test(videoId) ? videoId : false;
    } catch (error) {
        return false;
    }
}

// --- BASIC UI & VALIDATION ---
document.getElementById('username').addEventListener('input', function (e) {
    this.value = this.value.replace(/[^a-zA-Z\s]/g, '');
});
document.getElementById('roomId').addEventListener('input', function (e) {
    this.value = this.value.replace(/\D/g, '');
});

function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function showLockedModal() { document.getElementById('locked-modal').classList.remove('hidden'); }
function showToast(msg, bgClass) {
    const div = document.createElement('div');
    div.className = "toast " + bgClass;
    div.innerHTML = msg;
    document.getElementById('toast-area').appendChild(div);
    setTimeout(() => div.remove(), 3000);
}

// --- JOIN ROOM ---
async function enterRoom(isCreating) {
    const nameVal = document.getElementById('username').value.trim();
    const roomVal = document.getElementById('roomId').value.trim();

    if (!nameVal) return showToast("Please enter your name!", "bg-red");
    if (!roomVal) return showToast("Please enter a Room Code!", "bg-red");

    username = nameVal;
    currentRoom = roomPrefix + roomVal;
    sessionStorage.setItem('syncPlayerUsername:' + roomMode, username);
    sessionStorage.setItem('syncPlayerRoom:' + roomMode, roomVal);
    sessionStorage.setItem('syncPlayerUsername', username);
    sessionStorage.setItem('syncPlayerRoom', currentRoom);

    try {
        if (isCreating) {
            const response = await fetch('/api/create-room', { method: 'POST', body: currentRoom });
            if (response.status === 409) return showToast("Room already exists!", "bg-red");
            if (response.ok) connect(true);
        } else {
            const res = await fetch('/api/room-status/' + currentRoom);
            const status = await res.text();
            if (status === "NOT_FOUND") return showToast("Room not found!", "bg-red");
            if (status === "LOCKED") return showLockedModal();
            connect(false);
        }
    } catch (e) { showToast("Server Error", "bg-red"); }
}

function connect(isCreating, forceReconnect = false) {
    if (forceReconnect && stompClient) {
        const oldClient = stompClient;
        stompClient = null;
        try { oldClient.disconnect(); } catch (error) { /* already disconnected */ }
        isConnecting = false;
    }
    if (isConnecting || (stompClient && stompClient.connected)) return;
    isConnecting = true;
    const socket = new SockJS('/ws-video');
    const client = Stomp.over(socket);
    stompClient = client;
    socket.onclose = () => { if (stompClient === client) handleConnectionLoss(); };
    stompClient.connect({}, function () {
        isConnecting = false;
        hasJoined = false;
        clearTimeout(reconnectTimer);
        setConnectionStatus(true);
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('player-ui').classList.remove('hidden');
        document.querySelector('.room-back-btn').classList.add('hidden');
        document.getElementById('header-user-info').classList.remove('hidden');
        document.getElementById('display-username').innerText = username;
        document.getElementById('room-title').innerText = currentRoom.substring(roomPrefix.length);
        document.getElementById('camToggleBtn').style.display = 'flex';
        document.getElementById('micToggleBtn').style.display = 'flex';
        document.getElementById('exitRoomBtn').style.display = 'flex';
        lockBtn.style.display = 'none';

        if(isCreating) checkOwnership(username);

        stompClient.subscribe('/topic/room/' + currentRoom, onMessageReceived);
        stompClient.subscribe('/user/topic/errors', onErrorReceived);

        stompClient.send("/app/room/" + currentRoom + "/join", {}, JSON.stringify({
            type: 'JOIN', sender: username, time: 0.0, duration: 0.0
        }));
    }, function (error) {
        handleConnectionLoss();
    });
}

function handleConnectionLoss() {
    if (isLeavingPage) return;
    isConnecting = false;
    setConnectionStatus(false);
    if (ytPlayer) ytPlayer.pauseVideo();
    const oldClient = stompClient;
    stompClient = null;
    if (oldClient) {
        try { oldClient.disconnect(); } catch (error) { /* already disconnected */ }
    }
    scheduleReconnect();
}

function setConnectionStatus(isConnected) {
    statusDot.classList.toggle('online', isConnected);
    statusDot.classList.toggle('offline', !isConnected);
}

function scheduleReconnect() {
    if (isLeavingPage || !currentRoom || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (navigator.onLine) connect(false);
        else scheduleReconnect();
    }, 2000);
}

function pauseRoomPlayback() {
    if (ytPlayer) ytPlayer.pauseVideo();
    if (stompClient && stompClient.connected && currentRoom) {
        stompClient.send("/app/room/" + currentRoom + "/sync", {}, JSON.stringify({
            type: 'SYNC', sender: username, action: 'PAUSE', time: ytPlayer ? ytPlayer.getCurrentTime() : 0, duration: 0.0
        }));
    }
}

window.addEventListener('online', () => { setConnectionStatus(true); if (currentRoom) connect(false, true); });
window.addEventListener('offline', () => { setConnectionStatus(false); if (ytPlayer) ytPlayer.pauseVideo(); });
window.addEventListener('pagehide', () => { isLeavingPage = true; pauseRoomPlayback(); });

function exitRoom() {
    if (!currentRoom) return;
    isLeavingPage = true;
    pauseRoomPlayback();
    localCamStream?.getTracks().forEach(track => track.stop());
    localMicStream?.getTracks().forEach(track => track.stop());
    Object.values(mediaPeerConnections).forEach(connection => connection.close());
    Object.values(remoteAudioElements).forEach(audio => audio.remove());
    if (ytPlayer) ytPlayer.stopVideo();
    stompClient?.disconnect();
    stompClient = null;
    localCamStream = null;
    localMicStream = null;
    currentRoom = '';
    roomUsers = [];
    currentOwner = '';
    amIHost = false;
    sessionStorage.removeItem('syncPlayerRoom:' + roomMode);
    sessionStorage.removeItem('syncPlayerUsername:' + roomMode);
    sessionStorage.removeItem('syncPlayerRoom');
    sessionStorage.removeItem('syncPlayerUsername');
    document.getElementById('username').value = '';
    document.getElementById('roomId').value = '';
    document.getElementById('player-ui').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
    document.querySelector('.room-back-btn').classList.remove('hidden');
    document.getElementById('header-user-info').classList.add('hidden');
    document.getElementById('camToggleBtn').style.display = 'none';
    document.getElementById('micToggleBtn').style.display = 'none';
    document.getElementById('exitRoomBtn').style.display = 'none';
    lockBtn.style.display = 'none';
    setConnectionStatus(navigator.onLine);
    updateUserList([]);
}

function onErrorReceived(payload) {
    const data = JSON.parse(payload.body);
    if (data.type === 'ERROR_LOCKED') showLockedModal();
}

// --- YOUTUBE PLAY BUTTON ---
document.getElementById('ytPlayBtn').onclick = function() {
    const url = document.getElementById('ytSearchInput').value;
    const videoId = extractVideoID(url);
    
    if(!videoId) {
        return showToast("Invalid YouTube URL!", "bg-red");
    }

    // Broadcast the new video ID to everyone using your existing SYNC payload
    stompClient.send("/app/room/" + currentRoom + "/sync", {}, JSON.stringify({
        type: 'SYNC', sender: username, action: 'LOAD_YT', text: videoId, time: 0.0, duration: 0.0
    }));
};

function initYouTubePlayer(videoId) {
    if (!isYtApiReady) {
        setTimeout(() => initYouTubePlayer(videoId), 500);
        return;
    }

    blocker.classList.add('hidden');
    document.getElementById('open-youtube-btn').classList.add('hidden');
    currentVideoId = videoId;

    if (ytPlayer) {
        ytPlayer.loadVideoById(videoId);
    } else {
        ytPlayer = new YT.Player('yt-player-container', {
            videoId: videoId,
            playerVars: {
                'autoplay': 1,
                'controls': 1,
                'rel': 0,
                'enablejsapi': 1,
                'origin': window.location.origin,
                'playsinline': 1
            },
            events: {
                'onStateChange': onPlayerStateChange,
                'onError': onYouTubeError
            }
        });
    }
}

function onYouTubeError(event) {
    const messages = {
        2: 'The YouTube link is invalid.',
        5: 'This video cannot be played in the HTML5 player.',
        100: 'This video is private or no longer available.',
        101: 'This video does not allow playback in embedded players.',
        150: 'This video does not allow playback in embedded players.',
        153: 'YouTube could not verify this embedded player.'
    };
    const message = messages[event.data] || 'YouTube could not play this video on this device.';
    blocker.classList.remove('hidden');
    document.getElementById('blocker-msg').textContent = 'Video unavailable';
    document.getElementById('blocker-sub').textContent = message;
    const openButton = document.getElementById('open-youtube-btn');
    openButton.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(currentVideoId);
    openButton.classList.remove('hidden');
    showToast(message, 'bg-red');
}

// Map YouTube events to your WebSocket Sync
function onPlayerStateChange(event) {
    if (isRemoteUpdate || !ytPlayer) return;

    const currentTime = ytPlayer.getCurrentTime();

    if (event.data === YT.PlayerState.PLAYING) {
        sendSync('PLAY', currentTime);
    } else if (event.data === YT.PlayerState.PAUSED) {
        sendSync('PAUSE', currentTime);
    }
}

function sendSync(action, time) {
    stompClient.send("/app/room/" + currentRoom + "/sync", {}, JSON.stringify({
        type: 'SYNC', sender: username, action: action, time: time, duration: ytPlayer.getDuration() || 0.0
    }));
}

// --- MESSAGE HANDLER ---
function onMessageReceived(payload) {
    const data = JSON.parse(payload.body);
    if (data.activeUsers) {
        roomUsers = data.activeUsers;
        updateUserList(roomUsers);
    }

    if (data.type === 'ERROR_NAME_TAKEN') {
        if (data.sender === username && !hasJoined) {
            alert("Username '" + username + "' is taken. Please choose another.");
            window.location.reload();
        }
    }
    else if (data.type === 'WEBRTC') {
        if (data.action === 'VIDEO_OFF' || data.action === 'CAM_OFF') {
            document.getElementById(`cam-${data.sender}`)?.remove();
            const stream = remoteMediaStreams[data.sender];
            stream?.getVideoTracks().forEach(track => stream.removeTrack(track));
            if (stream && remoteAudioElements[data.sender]) {
                remoteAudioElements[data.sender].srcObject = stream;
            }
            if (camWrapper.children.length === 0) camWrapper.classList.add('hidden');
        } else if (data.target === username) {
            handleMediaSignal(data.sender, data.text);
        }
    }
    else if (data.type === 'LOCK_UPDATE') {
        const isLocked = (data.duration === 1.0);
        updateLockUI(isLocked);
        if (data.sender === "System") showToast("Room is now " + (isLocked ? "LOCKED 🔒" : "UNLOCKED 🔓"), isLocked ? "bg-red" : "bg-green");
    }
    else if (data.type === 'REACTION') showFloatingEmoji(data.text);
    else if (data.type === 'TYPING' && data.sender !== username) showTypingIndicator(data.sender);
    else if (data.type === 'CHAT') {
        addChatMessage(data.sender, data.text);
        if (data.sender !== username) playSound();
    }
    else if (data.type === 'JOIN') {
        if (data.sender === username) {
            hasJoined = true;
            if (currentVideoId && amIHost) {
                stompClient.send("/app/room/" + currentRoom + "/sync", {}, JSON.stringify({
                    type: 'SYNC', sender: username, action: 'LOAD_YT', text: currentVideoId,
                    time: ytPlayer ? ytPlayer.getCurrentTime() : 0.0, duration: 0.0
                }));
            }
        }
        checkOwnership(data.text);
        showToast(data.sender + " joined!", "bg-blue");
        addChatMessage("System", data.sender + " joined the room.");
        
        // If someone new joins and a video is playing, send them the current video ID and time
        if (amIHost && ytPlayer && currentVideoId && data.sender !== username) {
            stompClient.send("/app/room/" + currentRoom + "/sync", {}, JSON.stringify({
                type: 'SYNC', sender: username, action: 'LOAD_YT', text: currentVideoId, time: ytPlayer.getCurrentTime(), duration: 0.0
            }));
        }
        if ((localCamStream || localMicStream) && data.sender !== username) {
            createMediaPeerConnection(data.sender);
        }
    }
    else if (data.type === 'LEAVE') {
        showToast(data.sender + " left.", "bg-red");
        addChatMessage("System", data.sender + " left the room.");
        if (data.text && data.text !== "Left") {
            const justBecameHost = checkOwnership(data.text);
            if (justBecameHost) showToast("You are now the Host 👑", "bg-green");
        }
    }
    else if (data.type === 'SYNC') {
        // Load a new YouTube Video
        if (data.action === 'LOAD_YT') {
            document.getElementById('ytSearchInput').value = ""; // Clear input
            initYouTubePlayer(data.text);
            
            // If the host passed a timestamp (because a late viewer joined), seek to it
            if (data.time > 0) {
                setTimeout(() => {
                    isRemoteUpdate = true;
                    ytPlayer.seekTo(data.time, true);
                    ytPlayer.playVideo();
                    setTimeout(() => isRemoteUpdate = false, 500);
                }, 1500);
            }
        }
        // Handle Play/Pause/Seek from remote users
        else if (data.sender !== username && ytPlayer) {
            isRemoteUpdate = true;
            
            // Sync time if difference is greater than 1.5 seconds
            const timeDiff = Math.abs(ytPlayer.getCurrentTime() - data.time);
            if (timeDiff > 1.5) ytPlayer.seekTo(data.time, true);

            if (data.action === 'PLAY') {
                ytPlayer.playVideo();
                showToast(data.sender + " Played", "bg-blue");
            } else if (data.action === 'PAUSE') {
                ytPlayer.pauseVideo();
                showToast(data.sender + " Paused", "bg-blue");
            }
            
            setTimeout(() => isRemoteUpdate = false, 500);
        }
    }
}

// --- STANDARD ROOM LOGIC ---
function checkOwnership(ownerName) {
    const wasHost = amIHost;
    currentOwner = ownerName || "";
    amIHost = (username === ownerName);
    if (amIHost) lockBtn.style.display = "flex";
    else lockBtn.style.display = "none";
    updateUserList(roomUsers);
    return (amIHost && !wasHost);
}

function toggleLock() {
    if (!amIHost || !stompClient || !stompClient.connected) return;
    stompClient.send("/app/room/" + currentRoom + "/toggle-lock", {}, JSON.stringify({
        type: 'LOCK_TOGGLE', sender: username, time: 0.0, duration: 0.0
    }));
}

function updateLockUI(isLocked) {
    if (isLocked) {
        lockBtn.innerHTML = "🔒";
        lockBtn.classList.add("locked");
    } else {
        lockBtn.innerHTML = "🔓";
        lockBtn.classList.remove("locked");
    }
}

function sendReaction(emoji) {
    stompClient.send("/app/room/" + currentRoom + "/reaction", {}, JSON.stringify({
        type: 'REACTION', sender: username, text: emoji, time: 0.0, duration: 0.0
    }));
    showFloatingEmoji(emoji);
}

function showFloatingEmoji(emojiChar) {
    const container = document.getElementById('hearts-container');
    const el = document.createElement('div');
    el.classList.add('floating-emoji');
    el.innerText = emojiChar;
    el.style.left = (Math.random() * 80 + 10) + "%";
    container.appendChild(el);
    setTimeout(() => { el.remove(); }, 3000);
}

chatInput.addEventListener('input', () => {
    stompClient.send("/app/room/" + currentRoom + "/typing", {}, JSON.stringify({
        type: 'TYPING', sender: username, text: "typing", time: 0.0, duration: 0.0
    }));
});

let typingHideTimeout;
function showTypingIndicator(senderName) {
    const indicator = document.getElementById('typing-indicator');
    indicator.innerText = senderName + " is typing...";
    indicator.style.opacity = 1;
    clearTimeout(typingHideTimeout);
    typingHideTimeout = setTimeout(() => { indicator.style.opacity = 0; }, 1500);
}

function playSound() { notifSound.play().catch(e => console.log("Audio play failed")); }

function sendMessage() {
    const msg = chatInput.value;
    if (!msg) return;
    stompClient.send("/app/room/" + currentRoom + "/chat", {}, JSON.stringify({
        type: 'CHAT', sender: username, text: msg, time: 0.0, duration: 0.0
    }));
    chatInput.value = "";
}

chatInput.addEventListener("keypress", function (event) {
    if (event.key === "Enter") sendMessage();
});

function addChatMessage(sender, text) {
    const div = document.createElement('div');
    const isSystem = sender === "System";
    div.className = isSystem ? "message system" : "message";
    div.innerHTML = isSystem ? text : `<span>${sender}:</span> ${text}`;
    const box = document.getElementById('chat-messages');
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

function updateUserList(users) {
    const list = document.getElementById("user-list");
    list.innerHTML = "";
    users.forEach(u => {
        const li = document.createElement("li");
        li.className = "user-item";
        const initial = u.charAt(0).toUpperCase();
        li.innerHTML = `<div class="user-avatar">${initial}</div><span class="user-name">${u}</span>${u === currentOwner ? '<span class="host-badge">HOST</span>' : ''}`;
        list.appendChild(li);
    });
}

// --- CAMERA & MIC CONTROL ---
async function toggleMyCamera() {
    const camBtn = document.getElementById('camToggleBtn');
    if (localCamStream) {
        localCamStream.getVideoTracks().forEach(track => track.stop());
        localCamStream = null;
        camBtn.classList.remove('active');
        document.getElementById(`cam-${username}`)?.remove();
        if (document.getElementById('floating-cam-wrapper').children.length === 0) {
            document.getElementById('floating-cam-wrapper').classList.add('hidden');
        }
        if (stompClient && stompClient.connected) {
            stompClient.send("/app/room/" + currentRoom + "/webrtc", {}, JSON.stringify({
                type: 'WEBRTC', sender: username, action: 'VIDEO_OFF'
            }));
        }
        renegotiateMediaPeers();
        showToast("Camera Off", "bg-red");
        return;
    }

    try {
        localCamStream = await navigator.mediaDevices.getUserMedia({ video: true });
        camBtn.classList.add('active');
        addMediaBox(username, localCamStream, true);
        renegotiateMediaPeers();
        showToast("Camera On", "bg-green");
    } catch (err) {
        showMediaAccessError("camera", err);
    }
}

async function toggleMyMic() {
    if (!localMicStream) {
        try {
            localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            isMicMuted = false;
            updateMicButtons();
            renegotiateMediaPeers();
            showToast("Microphone On", "bg-green");
        } catch (err) {
            showMediaAccessError("microphone", err);
        }
        return;
    }

    isMicMuted = !isMicMuted;
    localMicStream.getAudioTracks().forEach(track => track.enabled = !isMicMuted);
    updateMicButtons();
}

function showMediaAccessError(device, error) {
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        showToast("Allow " + device + " only on HTTPS or localhost", "bg-red");
        return;
    }
    if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
        showToast("Allow " + device + " permission in browser settings", "bg-red");
        return;
    }
    showToast(device.charAt(0).toUpperCase() + device.slice(1) + " access failed", "bg-red");
}

function updateMicButtons() {
    const headerButton = document.getElementById('micToggleBtn');
    const inlineButton = document.getElementById(`inline-mic-${username}`);
    headerButton.classList.toggle('active', !isMicMuted);
    headerButton.classList.toggle('muted', isMicMuted);
    headerButton.innerHTML = isMicMuted ? "🔇" : "🎤";
    if (inlineButton) {
        inlineButton.classList.toggle('muted', isMicMuted);
        inlineButton.innerHTML = isMicMuted ? "🔇" : "🎤";
    }
}

function addMediaBox(peerName, stream, isLocal = false) {
    let box = document.getElementById(`cam-${peerName}`);
    if (!box) {
        box = document.createElement('div');
        box.className = 'cam-box';
        box.id = `cam-${peerName}`;
        box.innerHTML = `<video autoplay playsinline ${isLocal ? 'muted' : ''}></video>
            ${isLocal ? `<div class="cam-controls"><button class="cam-btn" id="inline-mic-${peerName}" onclick="toggleMyMic()">🎤</button></div>` : ''}
            <div class="cam-label">${peerName}</div>`;
        document.getElementById('floating-cam-wrapper').appendChild(box);
    }
    const video = box.querySelector('video');
    video.srcObject = stream;
    video.muted = isLocal;
    video.volume = 1;
    if (!isLocal) {
        const playRemoteMedia = () => video.play().catch(() => {
            showToast("Click the camera window to enable voice", "bg-blue");
        });
        video.addEventListener('click', playRemoteMedia);
        playRemoteMedia();
    }
    document.getElementById('floating-cam-wrapper').classList.remove('hidden');
}

document.addEventListener('pointerdown', () => {
    document.querySelectorAll('#floating-cam-wrapper video:not([muted])').forEach(video => {
        video.play().catch(() => {});
    });
    Object.values(remoteAudioElements).forEach(audio => audio.play().catch(() => {}));
}, { passive: true });

function handleRemoteTrack(peerName, track) {
    let stream = remoteMediaStreams[peerName];
    if (!stream) {
        stream = new MediaStream();
        remoteMediaStreams[peerName] = stream;
    }
    if (!stream.getTracks().some(existingTrack => existingTrack.id === track.id)) {
        stream.addTrack(track);
    }
    if (track.kind === 'audio') {
        let audio = remoteAudioElements[peerName];
        if (!audio) {
            audio = document.createElement('audio');
            audio.autoplay = true;
            audio.volume = 1;
            remoteAudioElements[peerName] = audio;
            document.body.appendChild(audio);
        }
        audio.srcObject = stream;
        audio.play().catch(() => {});
    } else if (track.kind === 'video') {
        addMediaBox(peerName, stream);
    }
}

function sendMediaSignal(target, payload) {
    payload.media = true;
    stompClient.send("/app/room/" + currentRoom + "/webrtc", {}, JSON.stringify({
        type: 'WEBRTC', sender: username, target: target, text: JSON.stringify(payload)
    }));
}

async function createMediaPeerConnection(targetUser) {
    mediaPeerConnections[targetUser]?.close();
    const peerConnection = new RTCPeerConnection(mediaRtcConfig);
    mediaPeerConnections[targetUser] = peerConnection;
    peerConnection.onicecandidate = event => {
        if (event.candidate) sendMediaSignal(targetUser, { ice: event.candidate });
    };
    peerConnection.ontrack = event => handleRemoteTrack(targetUser, event.track);
    if (localCamStream) localCamStream.getTracks().forEach(track => peerConnection.addTrack(track, localCamStream));
    if (localMicStream) localMicStream.getTracks().forEach(track => peerConnection.addTrack(track, localMicStream));
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendMediaSignal(targetUser, { sdp: peerConnection.localDescription });
}

function renegotiateMediaPeers() {
    roomUsers.forEach(peer => {
        if (peer !== username && (localCamStream || localMicStream)) createMediaPeerConnection(peer);
    });
}

async function handleMediaSignal(sender, signal) {
    const data = JSON.parse(signal);
    let peerConnection = mediaPeerConnections[sender];
    if (data.sdp?.type === 'offer') {
        peerConnection?.close();
        peerConnection = new RTCPeerConnection(mediaRtcConfig);
        mediaPeerConnections[sender] = peerConnection;
        remoteMediaStreams[sender] = new MediaStream();
        peerConnection.onicecandidate = event => {
            if (event.candidate) sendMediaSignal(sender, { ice: event.candidate });
        };
        peerConnection.ontrack = event => handleRemoteTrack(sender, event.track);
        if (localCamStream) localCamStream.getTracks().forEach(track => peerConnection.addTrack(track, localCamStream));
        if (localMicStream) localMicStream.getTracks().forEach(track => peerConnection.addTrack(track, localMicStream));
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
        for (const candidate of pendingMediaIceCandidates[sender] || []) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        delete pendingMediaIceCandidates[sender];
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        sendMediaSignal(sender, { sdp: peerConnection.localDescription });
    } else if (data.sdp?.type === 'answer' && peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
        for (const candidate of peerConnection.pendingIceCandidates || []) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        peerConnection.pendingIceCandidates = [];
    } else if (data.ice) {
        if (!peerConnection) (pendingMediaIceCandidates[sender] ||= []).push(data.ice);
        else if (peerConnection.remoteDescription) await peerConnection.addIceCandidate(new RTCIceCandidate(data.ice));
        else (peerConnection.pendingIceCandidates ||= []).push(data.ice);
    }
}