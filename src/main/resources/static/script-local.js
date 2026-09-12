let stompClient = null;
let currentRoom = "";
let username = "";
let isRemoteUpdate = false;
let hasJoined = false;
let amIHost = false;
let currentOwner = "";
let roomUsers = [];
let currentVideoDuration = 0;
let reconnectTimer = null;
let isConnecting = false;
let isLeavingPage = false;
const roomMode = 'local';
const roomPrefix = roomMode + ':';

// DOM Elements
const blocker = document.getElementById('blocker');
const replayOverlay = document.getElementById('replay-overlay');
const player = document.getElementById('videoPlayer');
const statusDot = document.getElementById('status-dot');
const lockBtn = document.getElementById('lockBtn');
const chatInput = document.getElementById('chatInput');
const notifSound = new Audio("https://codeskulptor-demos.commondatastorage.googleapis.com/pang/pop.mp3");
statusDot.classList.toggle('online', navigator.onLine);
statusDot.classList.toggle('offline', !navigator.onLine);

// WebRTC Media Variables
let localCamStream = null;
let localMicStream = null;
let isMicMuted = false;
const camPeerConnections = {};
const pendingCamIceCandidates = {};
const remoteMediaStreams = {};
const remoteAudioElements = {};
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const savedRoom = sessionStorage.getItem('syncPlayerRoom:' + roomMode);
const savedUsername = sessionStorage.getItem('syncPlayerUsername:' + roomMode);
if (savedRoom && savedUsername) {
    document.getElementById('username').value = savedUsername;
    document.getElementById('roomId').value = savedRoom;
    setTimeout(() => enterRoom(false), 0);
}

document.getElementById('username').addEventListener('input', function (e) { this.value = this.value.replace(/[^a-zA-Z\s]/g, ''); });
document.getElementById('roomId').addEventListener('input', function (e) { this.value = this.value.replace(/\D/g, ''); });

function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
function showLockedModal() { document.getElementById('locked-modal').classList.remove('hidden'); }
function showToast(msg, bgClass) {
    const div = document.createElement('div');
    div.className = "toast " + bgClass;
    div.innerHTML = msg;
    document.getElementById('toast-area').appendChild(div);
    setTimeout(() => div.remove(), 3000);
}

// --- DRAGGABLE FLOATING CAM ---
const camWrapper = document.getElementById('floating-cam-wrapper');
let isCamDragging = false;
let camDragStartX = 0;
let camDragStartY = 0;
let camOffsetX = 0;
let camOffsetY = 0;

camWrapper.addEventListener('pointerdown', event => {
    if (event.target.closest('.cam-btn')) return;
    isCamDragging = true;
    const rect = camWrapper.getBoundingClientRect();
    camDragStartX = event.clientX - rect.left;
    camDragStartY = event.clientY - rect.top;
    camWrapper.setPointerCapture(event.pointerId);
    camWrapper.classList.add('dragging');
});

camWrapper.addEventListener('pointermove', event => {
    if (!isCamDragging) return;
    const parentRect = document.getElementById('video-wrapper').getBoundingClientRect();
    const currentRect = camWrapper.getBoundingClientRect();
    const nextLeft = Math.min(parentRect.width - currentRect.width, Math.max(0, currentRect.left - parentRect.left + event.movementX));
    const nextTop = Math.min(parentRect.height - currentRect.height, Math.max(0, currentRect.top - parentRect.top + event.movementY));
    camOffsetX += nextLeft - (currentRect.left - parentRect.left);
    camOffsetY += nextTop - (currentRect.top - parentRect.top);
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

// --- CAMERA & MIC CONTROL ---
async function toggleMyCamera() {
    const camBtn = document.getElementById('camToggleBtn');

    if (localCamStream) {
        localCamStream.getVideoTracks().forEach(t => t.stop());
        localCamStream = null;
        camBtn.classList.remove('active');
        document.getElementById(`cam-${username}`)?.remove();
        if(camWrapper.children.length === 0) camWrapper.classList.add('hidden');
        
        stompClient.send("/app/room/" + currentRoom + "/webrtc", {}, JSON.stringify({ type: 'WEBRTC', sender: username, action: 'VIDEO_OFF' }));
        renegotiateCamPeers();
        showToast("Camera Off", "bg-red");
    } else {
        try {
            localCamStream = await navigator.mediaDevices.getUserMedia({ video: true });
            camBtn.classList.add('active');

            camWrapper.classList.remove('hidden');
            addVideoBox(username, localCamStream, true);

            renegotiateCamPeers();
            showToast("Camera On", "bg-green");
        } catch (err) {
            showMediaAccessError("camera", err);
        }
    }
}

async function toggleMyMic() {
    if (!localMicStream) {
        try {
            localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            isMicMuted = false;
            document.getElementById('micToggleBtn').classList.add('active');
            renegotiateCamPeers();
            updateMicButtons();
            showToast("Microphone On", "bg-green");
            return;
        } catch (err) {
            showMediaAccessError("microphone", err);
            return;
        }
    }
    
    isMicMuted = !isMicMuted;
    localMicStream.getAudioTracks().forEach(t => t.enabled = !isMicMuted);

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
    const headerMicBtn = document.getElementById('micToggleBtn');
    const inlineMicBtn = document.getElementById(`inline-mic-${username}`);

    if (isMicMuted) {
        headerMicBtn.classList.remove('active');
        headerMicBtn.classList.add('muted');
        headerMicBtn.innerHTML = "🔇";
        if (inlineMicBtn) {
            inlineMicBtn.classList.add('muted');
            inlineMicBtn.innerHTML = "🔇";
        }
    } else {
        headerMicBtn.classList.add('active');
        headerMicBtn.classList.remove('muted');
        headerMicBtn.innerHTML = "🎤";
        if (inlineMicBtn) {
            inlineMicBtn.classList.remove('muted');
            inlineMicBtn.innerHTML = "🎤";
        }
    }
}

function addVideoBox(peerName, stream, isLocal = false) {
    const existingBox = document.getElementById(`cam-${peerName}`);
    if (existingBox) {
        const video = existingBox.querySelector('video');
        video.srcObject = stream;
        if (!isLocal) video.play().catch(() => {});
        return;
    }
    
    const box = document.createElement('div');
    box.className = 'cam-box';
    box.id = `cam-${peerName}`;
    
    const inlineControls = isLocal ? `
        <div class="cam-controls">
            <button class="cam-btn ${isMicMuted ? 'muted' : ''}" id="inline-mic-${peerName}" onclick="toggleMyMic()">
                ${isMicMuted ? '🔇' : '🎤'}
            </button>
        </div>
    ` : '';

    box.innerHTML = `
        <video autoplay playsinline ${isLocal ? 'muted' : ''}></video>
        ${inlineControls}
        <div class="cam-label">${peerName}</div>
    `;
    camWrapper.appendChild(box);
    box.querySelector('video').srcObject = stream;
    if (!isLocal) box.querySelector('video').play().catch(() => {});
    camWrapper.classList.remove('hidden');
}

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
        addVideoBox(peerName, stream);
    }
}

document.addEventListener('pointerdown', () => {
    Object.values(remoteAudioElements).forEach(audio => audio.play().catch(() => {}));
}, { passive: true });

// --- WEBRTC SIGNALING LOGIC ---
function sendCamSignal(target, payload) {
    stompClient.send("/app/room/" + currentRoom + "/webrtc", {}, JSON.stringify({
        type: 'WEBRTC', sender: username, target: target, text: JSON.stringify(payload)
    }));
}

async function createCamPeerConnection(targetUser) {
    camPeerConnections[targetUser]?.close();
    const pc = new RTCPeerConnection(rtcConfig);
    camPeerConnections[targetUser] = pc;

    pc.onicecandidate = e => { if (e.candidate) sendCamSignal(targetUser, { ice: e.candidate }); };
    pc.ontrack = e => handleRemoteTrack(targetUser, e.track);

    if (localCamStream) localCamStream.getTracks().forEach(track => pc.addTrack(track, localCamStream));
    if (localMicStream) localMicStream.getTracks().forEach(track => pc.addTrack(track, localMicStream));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendCamSignal(targetUser, { sdp: pc.localDescription });
}

async function handleCamSignal(sender, signal) {
    if (signal === 'CAM_OFF' || signal === 'VIDEO_OFF') {
        document.getElementById(`cam-${sender}`)?.remove();
        const stream = remoteMediaStreams[sender];
        stream?.getVideoTracks().forEach(track => stream.removeTrack(track));
        if (stream && remoteAudioElements[sender]) remoteAudioElements[sender].srcObject = stream;
        if(camWrapper.children.length === 0) camWrapper.classList.add('hidden');
        return;
    }

    const data = JSON.parse(signal);
    let pc = camPeerConnections[sender];

    if (data.sdp) {
        if (data.sdp.type === 'offer') {
            pc?.close();
            pc = new RTCPeerConnection(rtcConfig);
            camPeerConnections[sender] = pc;
            remoteMediaStreams[sender] = new MediaStream();
            
            pc.onicecandidate = e => { if (e.candidate) sendCamSignal(sender, { ice: e.candidate }); };
            pc.ontrack = e => handleRemoteTrack(sender, e.track);
            if (localCamStream) localCamStream.getTracks().forEach(track => pc.addTrack(track, localCamStream));
            if (localMicStream) localMicStream.getTracks().forEach(track => pc.addTrack(track, localMicStream));

            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            for (const candidate of pendingCamIceCandidates[sender] || []) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
            delete pendingCamIceCandidates[sender];
            for (const candidate of pc.pendingIceCandidates || []) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
            pc.pendingIceCandidates = [];
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendCamSignal(sender, { sdp: pc.localDescription });
        } else if (data.sdp.type === 'answer' && pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        }
    } else if (data.ice) {
        if (!pc) (pendingCamIceCandidates[sender] ||= []).push(data.ice);
        else if (pc.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(data.ice)).catch(e => console.error(e));
        else (pc.pendingIceCandidates ||= []).push(data.ice);
    }
}

function renegotiateCamPeers() {
    roomUsers.forEach(peer => {
        if (peer !== username && (localCamStream || localMicStream)) createCamPeerConnection(peer);
    });
}

// --- STANDARD ROOM LOGIC ---
async function enterRoom(isCreating) {
    const nameVal = document.getElementById('username').value.trim();
    const roomVal = document.getElementById('roomId').value.trim();

    if (!nameVal) return showToast("Please enter your name!", "bg-red");
    if (!roomVal) return showToast("Please enter a Room Code!", "bg-red");

    username = nameVal;
    currentRoom = roomPrefix + roomVal;
    sessionStorage.setItem('syncPlayerUsername:' + roomMode, username);
    sessionStorage.setItem('syncPlayerRoom:' + roomMode, roomVal);

    try {
        if (isCreating) {
            const response = await fetch('/api/create-room', { method: 'POST', body: currentRoom });
            if (response.status === 409) return showToast("Room already exists!", "bg-red");
            if (response.ok) connect();
        } else {
            const res = await fetch('/api/room-status/' + currentRoom);
            const status = await res.text();
            if (status === "NOT_FOUND") return showToast("Room not found!", "bg-red");
            if (status === "LOCKED") return showLockedModal();
            connect();
        }
    } catch (e) { showToast("Server Error", "bg-red"); }
}

function connect(forceReconnect = false) {
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
    socket.onclose = () => {
        if (stompClient === client) handleConnectionLoss();
    };
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

        // --- REVEAL MEDIA BUTTONS NOW THAT WE ARE IN THE ROOM ---
        document.getElementById('micToggleBtn').style.display = 'flex';
        document.getElementById('camToggleBtn').style.display = 'flex';
        document.getElementById('exitRoomBtn').style.display = 'flex';
        lockBtn.style.display = 'none';

        stompClient.subscribe('/topic/room/' + currentRoom, onMessageReceived);
        stompClient.subscribe('/user/topic/errors', onErrorReceived);

        stompClient.send("/app/room/" + currentRoom + "/join", {}, JSON.stringify({ type: 'JOIN', sender: username }));
    }, function (error) {
        handleConnectionLoss();
    });
}

function handleConnectionLoss() {
    if (isLeavingPage) return;
    isConnecting = false;
    setConnectionStatus(false);
    player.pause();
    const oldClient = stompClient;
    stompClient = null;
    if (oldClient) {
        try { oldClient.disconnect(); } catch (error) { /* already disconnected */ }
    }
    showToast("Connection lost. Reconnecting...", "bg-red");
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
        if (navigator.onLine) connect();
        else scheduleReconnect();
    }, 2000);
}

function pauseRoomPlayback() {
    player.pause();
    if (stompClient && stompClient.connected && currentRoom) {
        stompClient.send("/app/room/" + currentRoom + "/sync", {}, JSON.stringify({
            type: 'SYNC', sender: username, action: 'PAUSE', time: player.currentTime, duration: player.duration || 0.0
        }));
    }
}

window.addEventListener('online', () => {
    setConnectionStatus(true);
    if (currentRoom) connect(true);
});
window.addEventListener('offline', () => {
    player.pause();
    setConnectionStatus(navigator.onLine);
});

window.addEventListener('pagehide', () => {
    isLeavingPage = true;
    pauseRoomPlayback();
});

function exitRoom() {
    if (!currentRoom) return;

    isLeavingPage = true;
    pauseRoomPlayback();
    localCamStream?.getTracks().forEach(track => track.stop());
    localMicStream?.getTracks().forEach(track => track.stop());
    Object.values(camPeerConnections).forEach(connection => connection.close());
    Object.values(remoteAudioElements).forEach(audio => audio.remove());
    Object.keys(remoteAudioElements).forEach(peer => delete remoteAudioElements[peer]);
    stompClient?.disconnect();
    stompClient = null;
    localCamStream = null;
    localMicStream = null;
    currentRoom = '';
    roomUsers = [];
    amIHost = false;
    currentOwner = '';
    sessionStorage.removeItem('syncPlayerRoom:' + roomMode);
    sessionStorage.removeItem('syncPlayerUsername:' + roomMode);
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
    setConnectionStatus(false);
    updateUserList([]);
}

function onErrorReceived(payload) {
    const data = JSON.parse(payload.body);
    if (data.type === 'ERROR_LOCKED') showLockedModal();
}

document.getElementById('fileInput').onchange = function (e) {
    const file = e.target.files[0];
    if (!file) return;
    player.src = URL.createObjectURL(file);
    player.pause();
    blocker.classList.remove('hidden');
    document.getElementById('blocker-msg').innerText = "Verifying Video...";
    document.getElementById('blocker-sub').innerText = "Checking if friends have the same file...";

    player.onloadedmetadata = function () {
        let dur = player.duration;
        currentVideoDuration = isNaN(dur) ? 0 : dur;
        sessionStorage.setItem('syncPlayerVideoDuration', currentVideoDuration.toString());
        stompClient.send("/app/room/" + currentRoom + "/file-check", {}, JSON.stringify({ type: 'FILE_INFO', sender: username, duration: isNaN(dur)?0.0:dur }));
    };
};

function announceSelectedVideo() {
    if (!stompClient || !stompClient.connected || !currentRoom) return;
    const duration = currentVideoDuration || player.duration;
    if (duration && isFinite(duration) && duration > 0) {
        stompClient.send("/app/room/" + currentRoom + "/file-check", {}, JSON.stringify({
            type: 'FILE_INFO', sender: username, duration: duration
        }));
    }
}

function sendReplay() { stompClient.send("/app/room/" + currentRoom + "/replay", {}, JSON.stringify({ type: 'REPLAY_REQ', sender: username })); }

function onMessageReceived(payload) {
    const data = JSON.parse(payload.body);
    if (data.activeUsers) {
        roomUsers = data.activeUsers;
        updateUserList(roomUsers);
    }

    if (data.type === 'WEBRTC') {
        if (data.action === 'CAM_OFF' || data.action === 'VIDEO_OFF') handleCamSignal(data.sender, data.action);
        else if (data.target === username) handleCamSignal(data.sender, data.text);
    }
    else if (data.type === 'ERROR_NAME_TAKEN' && data.sender === username && !hasJoined) {
        alert("Username taken.");
        window.location.reload();
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
            announceSelectedVideo();
        }
        checkOwnership(data.text);
        showToast(data.sender + " joined!", "bg-blue");
        addChatMessage("System", data.sender + " joined the room.");
        
        if ((localCamStream || localMicStream) && data.sender !== username) createCamPeerConnection(data.sender);
    }
    else if (data.type === 'LEAVE') {
        showToast(data.sender + " left.", "bg-red");
        addChatMessage("System", data.sender + " left the room.");
        
        document.getElementById(`cam-${data.sender}`)?.remove();
        delete remoteMediaStreams[data.sender];
        if(camWrapper.children.length === 0) camWrapper.classList.add('hidden');

        if (data.text && data.text !== "Left") {
            if (checkOwnership(data.text)) showToast("You are now the Host 👑", "bg-green");
        }
        if (data.activeUsers && data.activeUsers.length < 2) {
            player.pause();
            blocker.classList.remove('hidden');
        }
    }
    else if (data.type === 'WAIT' || data.type === 'ERROR') {
        player.pause();
        blocker.classList.remove('hidden');
        document.getElementById('blocker-msg').innerText = data.type === 'ERROR' ? "Video Mismatch" : "Friend Changing Video";
    }
    else if (data.type === 'READY') {
        blocker.classList.add('hidden');
        replayOverlay.classList.add('hidden');
        showToast("Synced & Ready!", "bg-green");
        if (player.currentTime > 1) setTimeout(() => sendSync(player.paused ? 'PAUSE' : 'PLAY'), 500);
    }
    else if (data.type === 'RESET') {
        if (document.fullscreenElement) document.exitFullscreen();
        player.pause();
        player.currentTime = 0;
        blocker.classList.add('hidden');
        replayOverlay.classList.remove('hidden');
    }
    else if (data.type === 'SYNC') {
        if (data.action === 'REPLAY') {
            isRemoteUpdate = true;
            replayOverlay.classList.add('hidden');
            player.currentTime = 0;
            player.play().catch(e => console.log(e));
            setTimeout(() => isRemoteUpdate = false, 1000);
        }
        else if (data.sender !== username) {
            isRemoteUpdate = true;
            if (Math.abs(player.currentTime - data.time) > 0.5) player.currentTime = data.time;
            if (data.action === 'PLAY') player.play().catch(e=>console.log(e));
            if (data.action === 'PAUSE') player.pause();
            setTimeout(() => isRemoteUpdate = false, 300);
        }
    }
}

function checkOwnership(ownerName) {
    const wasHost = amIHost;
    currentOwner = ownerName || "";
    amIHost = (username === ownerName);
    lockBtn.style.display = amIHost ? "flex" : "none";
    updateUserList(roomUsers);
    return (amIHost && !wasHost);
}

function toggleLock() {
    if (!amIHost || !stompClient || !stompClient.connected) return;
    stompClient.send("/app/room/" + currentRoom + "/toggle-lock", {}, JSON.stringify({ type: 'LOCK_TOGGLE', sender: username }));
}
function updateLockUI(isLocked) { lockBtn.innerHTML = isLocked ? "🔒" : "🔓"; lockBtn.classList.toggle("locked", isLocked); }
function sendReaction(emoji) { stompClient.send("/app/room/" + currentRoom + "/reaction", {}, JSON.stringify({ type: 'REACTION', sender: username, text: emoji })); showFloatingEmoji(emoji); }
function showFloatingEmoji(char) { const el = document.createElement('div'); el.classList.add('floating-emoji'); el.innerText = char; el.style.left = (Math.random()*80+10)+"%"; document.getElementById('hearts-container').appendChild(el); setTimeout(()=>el.remove(), 3000); }

chatInput.addEventListener('input', () => stompClient.send("/app/room/" + currentRoom + "/typing", {}, JSON.stringify({ type: 'TYPING', sender: username })));
let typingHideTimeout;
function showTypingIndicator(senderName) { document.getElementById('typing-indicator').innerText = senderName + " is typing..."; document.getElementById('typing-indicator').style.opacity = 1; clearTimeout(typingHideTimeout); typingHideTimeout = setTimeout(() => document.getElementById('typing-indicator').style.opacity = 0, 1500); }
function playSound() { notifSound.play().catch(e => console.log(e)); }

function sendMessage() { const msg = chatInput.value; if (!msg) return; stompClient.send("/app/room/" + currentRoom + "/chat", {}, JSON.stringify({ type: 'CHAT', sender: username, text: msg })); chatInput.value = ""; }
chatInput.addEventListener("keypress", e => { if (e.key === "Enter") sendMessage(); });
function addChatMessage(sender, text) { const div = document.createElement('div'); div.className = sender === "System" ? "message system" : "message"; div.innerHTML = sender === "System" ? text : `<span>${sender}:</span> ${text}`; const box = document.getElementById('chat-messages'); box.appendChild(div); box.scrollTop = box.scrollHeight; }

function updateUserList(users) { const list = document.getElementById("user-list"); list.innerHTML = ""; users.forEach(u => { const li = document.createElement("li"); li.className = "user-item"; li.innerHTML = `<div class="user-avatar">${u.charAt(0).toUpperCase()}</div><span class="user-name">${u}</span>${u === currentOwner ? '<span class="host-badge">HOST</span>' : ''}`; list.appendChild(li); }); }

player.onplay = () => sendSync('PLAY');
player.onpause = () => sendSync('PAUSE');
player.onseeked = () => { sendSync('SEEK'); if (!player.paused) setTimeout(() => sendSync('PLAY'), 50); };
player.onended = () => { replayOverlay.classList.remove('hidden'); stompClient.send("/app/room/" + currentRoom + "/reset", {}, JSON.stringify({ type: 'RESET', sender: username })); };
document.addEventListener("visibilitychange", () => { if (!stompClient || !currentRoom) return; if (document.visibilityState === 'hidden') player.pause(); else if (document.visibilityState === 'visible') setTimeout(() => sendSync('PAUSE'), 500); });
function sendSync(action) { if (isRemoteUpdate || !blocker.classList.contains('hidden')) return; stompClient.send("/app/room/" + currentRoom + "/sync", {}, JSON.stringify({ type: 'SYNC', sender: username, action: action, time: player.currentTime, duration: player.duration || 0.0 })); }

