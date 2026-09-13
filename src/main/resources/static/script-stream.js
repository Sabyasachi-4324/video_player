let stompClient = null;
let currentRoom = "";
let username = "";
let hasJoined = false;
let amIHost = false;
let currentOwner = "";
let roomUsers = []; // Track everyone in the room
let reconnectTimer = null;
let isConnecting = false;
let isLeavingPage = false;
const roomMode = 'stream';
const roomPrefix = roomMode + ':';

// WebRTC Variables
let localStream = null;
const peerConnections = {}; // Map to hold a connection for each viewer
const pendingPeerIceCandidates = {};
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }, // Free Google STUN server to help browsers find each other
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// DOM Elements
const streamPlayer = document.getElementById('streamPlayer');
const blocker = document.getElementById('blocker');
const blockerMsg = document.getElementById('blocker-msg');
const blockerSub = document.getElementById('blocker-sub');
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
const mediaRtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const remoteAudioElements = {};
const incomingBroadcastStreams = {};

const camWrapper = document.getElementById('floating-cam-wrapper');
function enableCamDragging(box) {
    if (box.dataset.draggable === 'true') return;
    box.dataset.draggable = 'true';
    box.addEventListener('pointerdown', event => {
        if (event.target.closest('.cam-btn')) return;
        box._dragStartX = event.clientX;
        box._dragStartY = event.clientY;
        box._dragOffsetX = box._dragOffsetX || 0;
        box._dragOffsetY = box._dragOffsetY || 0;
        box.setPointerCapture(event.pointerId);
        box.classList.add('dragging');
    });
    box.addEventListener('pointermove', event => {
        if (!box.hasPointerCapture(event.pointerId)) return;
        const parentRect = document.getElementById('video-wrapper').getBoundingClientRect();
        const boxRect = box.getBoundingClientRect();
        const nextX = Math.min(parentRect.right - boxRect.width, Math.max(parentRect.left, boxRect.left + event.clientX - box._dragStartX));
        const nextY = Math.min(parentRect.bottom - boxRect.height, Math.max(parentRect.top, boxRect.top + event.clientY - box._dragStartY));
        box._dragOffsetX += nextX - boxRect.left;
        box._dragOffsetY += nextY - boxRect.top;
        box.style.transform = `translate(${box._dragOffsetX}px, ${box._dragOffsetY}px)`;
        box._dragStartX = event.clientX;
        box._dragStartY = event.clientY;
    });
    box.addEventListener('pointerup', event => {
        box.releasePointerCapture(event.pointerId);
        box.classList.remove('dragging');
    });
    box.addEventListener('pointercancel', () => box.classList.remove('dragging'));
}

const savedRoom = sessionStorage.getItem('syncPlayerRoom:' + roomMode);
const savedUsername = sessionStorage.getItem('syncPlayerUsername:' + roomMode);
if (savedRoom && savedUsername) {
    document.getElementById('username').value = savedUsername;
    document.getElementById('roomId').value = savedRoom;
    setTimeout(() => enterRoom(false), 0);
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

        if(isCreating) {
            document.querySelector('.host-only-controls').style.display = "flex";
            blockerMsg.innerText = "Ready to Broadcast";
            blockerSub.innerText = "Select a file above and click Start Broadcast.";
        }

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
    setConnectionStatus(navigator.onLine);
    streamPlayer.pause();
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
    streamPlayer.pause();
    if (stompClient && stompClient.connected && currentRoom) {
        stompClient.send("/app/room/" + currentRoom + "/sync", {}, JSON.stringify({
            type: 'SYNC', sender: username, action: 'PAUSE', time: streamPlayer.currentTime, duration: streamPlayer.duration || 0.0
        }));
    }
}

window.addEventListener('online', () => { if (currentRoom) connect(false, true); });
window.addEventListener('offline', () => { setConnectionStatus(false); streamPlayer.pause(); });
window.addEventListener('pagehide', () => { if (currentRoom) exitRoom(); });

function exitRoom() {
    if (!currentRoom) return;
    isLeavingPage = true;
    pauseRoomPlayback();
    localCamStream?.getTracks().forEach(track => track.stop());
    localMicStream?.getTracks().forEach(track => track.stop());
    localStream?.getTracks().forEach(track => track.stop());
    Object.values(peerConnections).forEach(connection => connection.close());
    Object.values(mediaPeerConnections).forEach(connection => connection.close());
    Object.values(remoteAudioElements).forEach(audio => audio.remove());
    stompClient?.disconnect();
    stompClient = null;
    localStream = null;
    localCamStream = null;
    localMicStream = null;
    currentRoom = '';
    roomUsers = [];
    currentOwner = '';
    amIHost = false;
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

// --- MESSAGE HANDLER ---
function onMessageReceived(payload) {
    const data = JSON.parse(payload.body);
    const wasAlreadyInRoom = roomUsers.includes(data.sender);
    
    // Track active users
    if (data.activeUsers) {
        roomUsers = data.activeUsers;
        updateUserList(roomUsers);
    }

    // Standard Messaging
    if (data.type === 'ERROR_NAME_TAKEN') {
        if (data.sender === username && !hasJoined) {
            showToast("Username '" + username + "' is already in this room. Please choose another.", "bg-red");
            exitRoom();
        }
    }
    else if (data.type === 'LOCK_UPDATE') {
        const isLocked = (data.duration === 1.0);
        updateLockUI(isLocked);
        if (data.sender === "System") {
            showToast("Room is now " + (isLocked ? "LOCKED 🔒" : "UNLOCKED 🔓"), isLocked ? "bg-red" : "bg-green");
        }
    }
    else if (data.type === 'REACTION') showFloatingEmoji(data.text);
    else if (data.type === 'TYPING' && data.sender !== username) showTypingIndicator(data.sender);
    else if (data.type === 'CHAT') {
        addChatMessage(data.sender, data.text);
        if (data.sender !== username) playSound();
    }
    else if (data.type === 'JOIN') {
        if (data.sender === username) hasJoined = true;
        checkOwnership(data.text);
        if (!wasAlreadyInRoom) {
            showToast(data.sender + " joined!", "bg-blue");
            addChatMessage("System", data.sender + " joined the room.");
        }
        
        // WEBRTC TRIGGER: If Host is broadcasting and a new user joins, send them the stream
        if (amIHost && localStream && data.sender !== username) {
            createPeerConnectionAndOffer(data.sender);
        }
        if ((localCamStream || localMicStream) && data.sender !== username) {
            createMediaPeerConnection(data.sender).catch(() => {});
        }
    }
    else if (data.type === 'LEAVE') {
        showToast(data.sender + " left.", "bg-red");
        addChatMessage("System", data.sender + " left the room.");
        
        // Clean up WebRTC connection for the user who left
        if (peerConnections[data.sender]) {
            peerConnections[data.sender].close();
            delete peerConnections[data.sender];
        }

        if (data.text && data.text !== "Left") {
            const justBecameHost = checkOwnership(data.text);
            if (justBecameHost) {
                showToast("You are now the Host 👑", "bg-green");
                document.querySelector('.host-only-controls').style.display = "flex";
            }
        }
    }
    // WEBRTC SIGNALING
    else if (data.type === 'WEBRTC') {
        if (data.action === 'VIDEO_OFF' || data.action === 'CAM_OFF') {
            document.getElementById(`cam-${data.sender}`)?.remove();
            const stream = remoteMediaStreams[data.sender];
            stream?.getVideoTracks().forEach(track => stream.removeTrack(track));
            if (stream && remoteAudioElements[data.sender]) remoteAudioElements[data.sender].srcObject = stream;
            mediaPeerConnections[data.sender]?.close();
            delete mediaPeerConnections[data.sender];
            delete pendingMediaIceCandidates[data.sender];
            delete remoteMediaStreams[data.sender];
            if (document.getElementById('floating-cam-wrapper').children.length === 0) {
                document.getElementById('floating-cam-wrapper').classList.add('hidden');
            }
            return;
        }
        // Ignore signals not targeted at this user
        if (data.target !== username) return;

        const signal = JSON.parse(data.text);
        if (signal.media) {
            handleMediaSignal(data.sender, data.text).catch(() => {});
            return;
        }
        
        if (signal.sdp) {
            handleReceiveSdp(data.sender, signal);
        } else if (signal.ice) {
            handleReceiveIce(data.sender, signal.ice);
        }
    }
}

// --- HOST BROADCAST CAPTURE ---
document.getElementById('streamFileInput').onchange = function (e) {
    const file = e.target.files[0];
    if (!file) return;
    
    // Load file into player but keep blocker up until they click Start
    streamPlayer.src = URL.createObjectURL(file);
    streamPlayer.pause();
    showToast("File loaded. Click Start Broadcast.", "bg-blue");
};

document.getElementById('startBroadcastBtn').onclick = function() {
    if (!streamPlayer.src) return showToast("Please select a file first!", "bg-red");

    // 1. Play the video locally (Muted by default to prevent echo if they screen share)
    streamPlayer.muted = false; 
    streamPlayer.play().catch(e => console.log("Play prevented"));
    blocker.classList.add('hidden');

    // 2. Capture the live stream from the video element
    if (streamPlayer.captureStream) {
        localStream = streamPlayer.captureStream();
    } else if (streamPlayer.mozCaptureStream) {
        localStream = streamPlayer.mozCaptureStream(); // Firefox fallback
    } else {
        return showToast("Your browser does not support broadcasting.", "bg-red");
    }

    showToast("📡 Broadcasting live!", "bg-green");

    // 3. Connect to all currently active viewers
    roomUsers.forEach(peerUsername => {
        if (peerUsername !== username) {
            createPeerConnectionAndOffer(peerUsername);
        }
    });
};


// --- WEBRTC PEER-TO-PEER ENGINE ---

// Send signaling data via the backend router
function sendWebRTCSignal(targetUser, payload) {
    stompClient.send("/app/room/" + currentRoom + "/webrtc", {}, JSON.stringify({
        type: 'WEBRTC', sender: username, target: targetUser, text: JSON.stringify(payload), time: 0.0, duration: 0.0
    }));
}

// Host creates an Offer
async function createPeerConnectionAndOffer(targetUser) {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections[targetUser] = pc;

    // Send ICE candidates to the viewer
    pc.onicecandidate = event => {
        if (event.candidate) {
            sendWebRTCSignal(targetUser, { ice: event.candidate });
        }
    };

    // Add Host's live video stream to the connection
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    // Create and send SDP Offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendWebRTCSignal(targetUser, { sdp: pc.localDescription });
}

// Handling Incoming SDP (Offer from Host, or Answer from Viewer)
async function handleReceiveSdp(sender, signal) {
    let pc = peerConnections[sender];

    // If Viewer receives an Offer, they need to create a connection to answer
    if (signal.sdp.type === 'offer') {
        pc = new RTCPeerConnection(rtcConfig);
        peerConnections[sender] = pc;

        // When the Viewer receives the live stream track, attach it to their video player
        pc.ontrack = event => {
            const receivedStream = incomingBroadcastStreams[sender] || new MediaStream();
            incomingBroadcastStreams[sender] = receivedStream;
            if (!receivedStream.getTracks().some(track => track.id === event.track.id)) {
                receivedStream.addTrack(event.track);
            }
            streamPlayer.srcObject = receivedStream;
            streamPlayer.onloadedmetadata = () => streamPlayer.play().catch(() => {});
            streamPlayer.play().catch(() => {});
            blocker.classList.add('hidden');
            showToast("📡 Stream Connected!", "bg-green");
        };

        // Send Viewer's ICE candidates back to the Host
        pc.onicecandidate = event => {
            if (event.candidate) {
                sendWebRTCSignal(sender, { ice: event.candidate });
            }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        for (const candidate of pendingPeerIceCandidates[sender] || []) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
        delete pendingPeerIceCandidates[sender];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendWebRTCSignal(sender, { sdp: pc.localDescription });
    } 
    // If Host receives the Answer, finalize connection
    else if (signal.sdp.type === 'answer') {
        if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
            for (const candidate of pc.pendingIceCandidates || []) {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
            pc.pendingIceCandidates = [];
        }
    }
}

// Add received ICE candidate to the connection
function handleReceiveIce(sender, iceCandidate) {
    const pc = peerConnections[sender];
    if (!pc) {
        (pendingPeerIceCandidates[sender] ||= []).push(iceCandidate);
        return;
    }
    if (pc.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(iceCandidate)).catch(e => console.error("Error adding ICE", e));
    else (pc.pendingIceCandidates ||= []).push(iceCandidate);
}

document.addEventListener('pointerdown', () => {
    if (streamPlayer.srcObject) streamPlayer.play().catch(() => {});
}, { passive: true });


// --- STANDARD ROOM LOGIC ---
function checkOwnership(ownerName) {
    const wasHost = amIHost;
    currentOwner = ownerName || "";
    amIHost = (username === ownerName);
    if (amIHost) lockBtn.style.display = "flex";
    else lockBtn.style.display = "none";
    const hostControls = document.querySelector('.host-only-controls');
    if (hostControls) hostControls.style.display = amIHost ? "flex" : "none";
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
        enableCamDragging(box);
        document.getElementById('floating-cam-wrapper').appendChild(box);
    }
    const video = box.querySelector('video');
    video.srcObject = stream;
    video.muted = true;
    video.onloadedmetadata = () => video.play().catch(() => {});
    if (!isLocal) video.play().catch(() => {});
    document.getElementById('floating-cam-wrapper').classList.remove('hidden');
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
        addMediaBox(peerName, stream);
    }
}

document.addEventListener('pointerdown', () => {
    Object.values(remoteAudioElements).forEach(audio => audio.play().catch(() => {}));
}, { passive: true });

function sendMediaSignal(target, payload) {
    if (!stompClient || !stompClient.connected || !currentRoom) return;
    payload.media = true;
    stompClient.send("/app/room/" + currentRoom + "/webrtc", {}, JSON.stringify({
        type: 'WEBRTC', sender: username, target: target, text: JSON.stringify(payload), time: 0.0, duration: 0.0
    }));
}

function syncMediaTracks(peerConnection) {
    const tracksByKind = {
        video: localCamStream?.getVideoTracks()[0] || null,
        audio: localMicStream?.getAudioTracks()[0] || null
    };
    Object.entries(tracksByKind).forEach(([kind, track]) => {
        let transceiver = peerConnection.getTransceivers().find(item => item.sender.track?.kind === kind || item.receiver.track?.kind === kind);
        if (!transceiver) transceiver = peerConnection.addTransceiver(kind, { direction: 'recvonly' });
        transceiver.sender.replaceTrack(track);
        transceiver.direction = track ? 'sendrecv' : 'recvonly';
    });
}

async function createMediaPeerConnection(targetUser) {
    let peerConnection = mediaPeerConnections[targetUser];
    if (peerConnection && peerConnection.signalingState !== 'stable') return;
    if (!peerConnection) {
        peerConnection = new RTCPeerConnection(mediaRtcConfig);
        mediaPeerConnections[targetUser] = peerConnection;
        peerConnection.onicecandidate = event => {
            if (event.candidate) sendMediaSignal(targetUser, { ice: event.candidate });
        };
        peerConnection.ontrack = event => handleRemoteTrack(targetUser, event.track);
    }
    syncMediaTracks(peerConnection);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendMediaSignal(targetUser, { sdp: peerConnection.localDescription });
}

function renegotiateMediaPeers() {
    roomUsers.forEach(peer => {
        if (peer !== username) {
            mediaPeerConnections[peer]?.close();
            delete mediaPeerConnections[peer];
            delete pendingMediaIceCandidates[peer];
            delete remoteMediaStreams[peer];
            createMediaPeerConnection(peer).catch(() => {});
        }
    });
}

async function handleMediaSignal(sender, signal) {
    const data = JSON.parse(signal);
    if (data.renegotiate) {
        createMediaPeerConnection(sender).catch(() => {});
        return;
    }
    let peerConnection = mediaPeerConnections[sender];
    if (data.sdp?.type === 'offer') {
        const offerCollision = peerConnection?.signalingState === 'have-local-offer';
        if (offerCollision && username.localeCompare(sender) < 0) return;
        if (offerCollision) {
            await peerConnection.setLocalDescription({ type: 'rollback' });
        } else {
            if (!peerConnection) {
                peerConnection = new RTCPeerConnection(mediaRtcConfig);
                mediaPeerConnections[sender] = peerConnection;
                remoteMediaStreams[sender] = new MediaStream();
                peerConnection.onicecandidate = event => {
                    if (event.candidate) sendMediaSignal(sender, { ice: event.candidate });
                };
                peerConnection.ontrack = event => handleRemoteTrack(sender, event.track);
            }
        }
        syncMediaTracks(peerConnection);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
        for (const candidate of pendingMediaIceCandidates[sender] || []) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        delete pendingMediaIceCandidates[sender];
        for (const candidate of peerConnection.pendingIceCandidates || []) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
        peerConnection.pendingIceCandidates = [];
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