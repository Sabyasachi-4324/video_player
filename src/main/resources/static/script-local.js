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
let camToggleInFlight = false;
let micToggleInFlight = false;
const camPeerConnections = {};
const pendingCamIceCandidates = {};
const remoteMediaStreams = {};
const remoteAudioElements = {};
const peerCamActive = {};
// Per-peer negotiation bookkeeping (Perfect Negotiation pattern)
// { makingOffer, ignoreOffer, isPolite, disconnectTimer }
const negotiationState = {};
// STUN alone is not enough - it only helps two peers discover their public
// address. When a direct P2P path is blocked (symmetric NAT, restrictive
// firewall, cross-network mobile <-> wifi, etc.) you need a TURN server to
// relay media, or that pair of peers will NEVER connect no matter how many
// times ICE is restarted. Replace with your own TURN credentials.
const rtcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    iceTransportPolicy: 'all'
};

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

// --- WEBRTC CORE HELPERS (CRASH-PROOF) ---

// Deterministic "polite" peer assignment so simultaneous offers (glare) resolve
// the same way on both ends instead of both sides rejecting each other's offer.
function isPolitePeer(peer) {
    return username > peer;
}

function getNegState(peer) {
    if (!negotiationState[peer]) {
        negotiationState[peer] = {
            makingOffer: false,
            ignoreOffer: false,
            isPolite: isPolitePeer(peer),
            disconnectTimer: null,
            iceRestartAttempts: 0,
            suppressNegotiation: false
        };
    }
    return negotiationState[peer];
}

function getTransceiver(pc, kind) {
    if (!pc || pc.signalingState === 'closed') {
        console.warn(`[WebRTC] PeerConnection is closed. Cannot get ${kind} transceiver.`);
        return null;
    }
    let tc = pc.getTransceivers().find(t => t.receiver && t.receiver.track && t.receiver.track.kind === kind);
    if (!tc) {
        try {
            console.log(`[WebRTC] Creating new ${kind} transceiver`);
            tc = pc.addTransceiver(kind, { direction: 'recvonly' });
        } catch (e) {
            console.error(`[WebRTC] Failed to add ${kind} transceiver:`, e);
            return null;
        }
    }
    return tc;
}

// A transceiver's direction is fixed at creation time and replaceTrack() alone
// does NOT change it. If we don't flip recvonly -> sendrecv here, the track
// gets attached to the sender but WebRTC silently never transmits it - this
// was the main cause of "camera on but the other person sees nothing".
function setTransceiverSending(tc, sending) {
    if (!tc) return;
    if (sending) {
        if (tc.direction === 'recvonly') tc.direction = 'sendrecv';
        else if (tc.direction === 'inactive') tc.direction = 'sendonly';
    } else {
        if (tc.direction === 'sendrecv') tc.direction = 'recvonly';
        else if (tc.direction === 'sendonly') tc.direction = 'inactive';
    }
}

async function attachTrackToTransceiver(pc, kind, track) {
    const tc = getTransceiver(pc, kind);
    if (!tc) return;
    try {
        await tc.sender.replaceTrack(track);
        setTransceiverSending(tc, !!track);
    } catch (e) {
        console.warn(`[WebRTC] Failed to attach ${kind} track:`, e);
    }
}

function initCamPeerConnection(peer, suppressNegotiation = false) {
    if (camPeerConnections[peer] && camPeerConnections[peer].signalingState !== 'closed') {
        return camPeerConnections[peer];
    }

    console.log(`[WebRTC] Initializing new PeerConnection for ${peer}`);
    const pc = new RTCPeerConnection(rtcConfig);
    camPeerConnections[peer] = pc;
    pendingCamIceCandidates[peer] = [];
    const negState = getNegState(peer);
    negState.suppressNegotiation = suppressNegotiation;

    pc.onconnectionstatechange = () => {
        console.log(`[WebRTC] Connection state with ${peer}: ${pc.connectionState}`);
        const negState = getNegState(peer);

        if (pc.connectionState === 'connected') {
            clearTimeout(negState.disconnectTimer);
            negState.disconnectTimer = null;
            negState.iceRestartAttempts = 0; // reset once we actually succeed
            return;
        }

        if (pc.connectionState === 'disconnected') {
            // 'disconnected' is frequently a transient ICE blip. Give it a
            // grace period and try an ICE restart - but only a few times.
            // restartIce() fires onnegotiationneeded and sends a fresh offer
            // over the signaling socket; if the pair genuinely can't reach
            // each other (no TURN, symmetric NAT, etc.) this would otherwise
            // retry forever, flooding the signaling connection and starving
            // it until it drops too. Cap it and give up cleanly instead.
            clearTimeout(negState.disconnectTimer);
            negState.disconnectTimer = setTimeout(() => {
                if (!camPeerConnections[peer]) return;
                if (pc.connectionState !== 'disconnected') return;

                if (negState.iceRestartAttempts >= 3) {
                    console.warn(`[WebRTC] ${peer} unreachable after ${negState.iceRestartAttempts} ICE restarts. Rebuilding the peer connection.`);
                    teardownPeerConnection(peer);
                    if (roomUsers.includes(peer) && !isLeavingPage) {
                        setTimeout(() => {
                            if (roomUsers.includes(peer) && !camPeerConnections[peer]) {
                                createCamPeerConnection(peer).catch(error => console.warn(`[WebRTC] Rebuild failed for ${peer}`, error));
                            }
                        }, 500);
                    }
                    return;
                }

                negState.iceRestartAttempts += 1;
                console.warn(`[WebRTC] ${peer} still disconnected, ICE restart attempt ${negState.iceRestartAttempts}`);
                try { pc.restartIce(); } catch (e) { console.warn('[WebRTC] restartIce failed', e); }
            }, 3000);
            return;
        }

        if (pc.connectionState === 'failed') {
            console.warn(`[WebRTC] Connection with ${peer} failed. Tearing down for a clean retry.`);
            teardownPeerConnection(peer);
        } else if (pc.connectionState === 'closed') {
            teardownPeerConnection(peer, /* pcAlreadyClosed */ true);
        }
    };

    // Single, centralized place offers get created. Any direction/track change
    // (see setTransceiverSending) fires this automatically instead of every
    // caller manually racing its own createOffer().
    pc.onnegotiationneeded = async () => {
        const negState = getNegState(peer);
        if (negState.suppressNegotiation) return;
        if (negState.makingOffer) return;
        try {
            negState.makingOffer = true;
            const offer = await pc.createOffer();
            if (pc.signalingState !== 'stable') return; // state moved on while we awaited
            await pc.setLocalDescription(offer);
            sendCamSignal(peer, { sdp: pc.localDescription, camOn: !!localCamStream, micOn: !!localMicStream && !isMicMuted });
        } catch (e) {
            console.error(`[WebRTC] Negotiation failed for ${peer}:`, e);
        } finally {
            negState.makingOffer = false;
        }
    };

    remoteMediaStreams[peer] = new MediaStream();

    pc.onicecandidate = e => {
        if (e.candidate) sendCamSignal(peer, { ice: e.candidate });
    };

    pc.ontrack = e => {
        console.log(`[WebRTC] Received remote ${e.track.kind} track from ${peer}. Enabled: ${e.track.enabled}`);
        const incomingStream = remoteMediaStreams[peer];
        if (!incomingStream.getTracks().includes(e.track)) incomingStream.addTrack(e.track);

        e.track.onunmute = () => {
            if (e.track.kind === 'video' && peerCamActive[peer] === true) addVideoBox(peer, incomingStream, false);
        };
        e.track.onended = () => {
            incomingStream.removeTrack(e.track);
        };

        if (e.track.kind === 'audio') {
            let audio = remoteAudioElements[peer];
            if (!audio) {
                audio = document.createElement('audio');
                audio.autoplay = true;
                remoteAudioElements[peer] = audio;
                document.body.appendChild(audio);
            }
            audio.srcObject = incomingStream;
            audio.play().catch(err => console.error(`[Audio] Auto-play blocked for ${peer}:`, err));
        } else if (e.track.kind === 'video') {
            if (peerCamActive[peer] === true) {
                addVideoBox(peer, incomingStream, false);
            }
        }
    };

    return pc;
}

// One place that fully tears a peer down: closes the pc (if needed) and wipes
// every piece of state tied to it (ICE queue, negotiation flags, remote
// stream, UI). Previously only the explicit LEAVE handler did this, so a
// connection killed by 'failed'/'disconnected' left stale streams and DOM
// nodes behind that corrupted the next reconnect.
function teardownPeerConnection(peer, pcAlreadyClosed = false) {
    const pc = camPeerConnections[peer];
    if (pc && !pcAlreadyClosed && pc.signalingState !== 'closed') {
        pc.close();
    }
    if (negotiationState[peer]) clearTimeout(negotiationState[peer].disconnectTimer);

    delete camPeerConnections[peer];
    delete pendingCamIceCandidates[peer];
    delete negotiationState[peer];
    delete remoteMediaStreams[peer];
    delete peerCamActive[peer];

    document.getElementById(`cam-${peer}`)?.remove();
    if (remoteAudioElements[peer]) {
        remoteAudioElements[peer].remove();
        delete remoteAudioElements[peer];
    }
    if (camWrapper.children.length === 0) camWrapper.classList.add('hidden');
}

function resetCamPeerConnections() {
    Object.keys(camPeerConnections).forEach(peer => teardownPeerConnection(peer));
}

// --- CAMERA & MIC CONTROL ---
async function toggleMyCamera() {
    if (camToggleInFlight) return;
    camToggleInFlight = true;
    console.log(`[Media] toggleMyCamera called. Current state: ${localCamStream ? 'ON' : 'OFF'}`);
    const camBtn = document.getElementById('camToggleBtn');

    try {
        if (localCamStream) {
            // TURN OFF
            localCamStream.getVideoTracks().forEach(t => t.stop());
            localCamStream = null;
            camBtn.classList.remove('active');
            document.getElementById(`cam-${username}`)?.remove();
            if (camWrapper.children.length === 0) camWrapper.classList.add('hidden');

            for (const peer of Object.keys(camPeerConnections)) {
                const pc = camPeerConnections[peer];
                await attachTrackToTransceiver(pc, 'video', null);
            }

            if (stompClient?.connected && currentRoom) {
                stompClient.send("/app/room/" + currentRoom + "/webrtc", {}, JSON.stringify({
                    type: 'WEBRTC', sender: username, action: 'CAM_STATE', camOn: false, text: JSON.stringify({ camOn: false })
                }));
            }
            showToast("Camera Off", "bg-red");
        } else {
            // TURN ON
            try {
                localCamStream = await navigator.mediaDevices.getUserMedia({ video: true });
            } catch (err) {
                console.error(`[Media] Camera access failed:`, err);
                showMediaAccessError("camera", err);
                return;
            }
            const videoTrack = localCamStream.getVideoTracks()[0];

            camBtn.classList.add('active');
            camWrapper.classList.remove('hidden');
            addVideoBox(username, localCamStream, true);

            for (const peer of roomUsers) {
                if (peer === username) continue;
                let pc = camPeerConnections[peer];
                if (pc && pc.signalingState === 'closed') {
                    teardownPeerConnection(peer, true);
                    pc = null;
                }
                if (!pc) {
                    createCamPeerConnection(peer).catch(() => { });
                } else {
                    await attachTrackToTransceiver(pc, 'video', videoTrack);
                }
            }

            if (stompClient?.connected && currentRoom) {
                stompClient.send("/app/room/" + currentRoom + "/webrtc", {}, JSON.stringify({
                    type: 'WEBRTC', sender: username, action: 'CAM_STATE', camOn: true, text: JSON.stringify({ camOn: true })
                }));
            }
            showToast("Camera On", "bg-green");
        }
    } finally {
        camToggleInFlight = false;
    }
}

async function toggleMyMic() {
    if (micToggleInFlight) return;
    micToggleInFlight = true;
    try {
        if (!localMicStream) {
            try {
                localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            } catch (err) {
                showMediaAccessError("microphone", err);
                return;
            }
            isMicMuted = false;
            document.getElementById('micToggleBtn').classList.add('active');

            const audioTrack = localMicStream.getAudioTracks()[0];
            for (const peer of roomUsers) {
                if (peer === username) continue;
                let pc = camPeerConnections[peer];
                if (pc && pc.signalingState === 'closed') {
                    teardownPeerConnection(peer, true);
                    pc = null;
                }
                if (!pc) {
                    createCamPeerConnection(peer).catch(() => { });
                } else {
                    await attachTrackToTransceiver(pc, 'audio', audioTrack);
                }
            }

            updateMicButtons();
            showToast("Microphone On", "bg-green");
            return;
        }

        isMicMuted = !isMicMuted;
        localMicStream.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
        updateMicButtons();
    } finally {
        micToggleInFlight = false;
    }
}

function showMediaAccessError(device, error) {
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        showToast("Allow " + device + " only on HTTPS or localhost", "bg-red");
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
    let box = document.getElementById(`cam-${peerName}`);

    if (box) {
        console.log(`[UI] Refreshing video pipeline for ${peerName}`);
        enableCamDragging(box);
        const video = box.querySelector('video');
        video.srcObject = null;
        video.srcObject = stream;
        video.muted = true;
        video.onloadedmetadata = () => video.play().catch(e => console.warn(`[UI] Re-play failed for ${peerName}`, e));
        video.play().catch(e => console.warn(`[UI] Re-play failed for ${peerName}`, e));
        return;
    }

    box = document.createElement('div');
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
    enableCamDragging(box);
    camWrapper.appendChild(box);

    const video = box.querySelector('video');
    video.srcObject = stream;
    video.muted = true;
    video.onloadedmetadata = () => video.play().catch(() => { });
    video.play().catch(() => { });
    camWrapper.classList.remove('hidden');
}

// --- WEBRTC SIGNALING LOGIC ---
function sendCamSignal(target, payload) {
    if (!stompClient || !stompClient.connected || !currentRoom) return;
    stompClient.send("/app/room/" + currentRoom + "/webrtc", {}, JSON.stringify({
        type: 'WEBRTC', sender: username, target: target, text: JSON.stringify(payload)
    }));
}

async function createCamPeerConnection(targetUser) {
    const pc = initCamPeerConnection(targetUser);

    if (localCamStream) {
        await attachTrackToTransceiver(pc, 'video', localCamStream.getVideoTracks()[0]);
    }
    if (localMicStream && !isMicMuted) {
        await attachTrackToTransceiver(pc, 'audio', localMicStream.getAudioTracks()[0]);
    }
    // onnegotiationneeded fires automatically from the transceiver/direction
    // changes above and sends the offer - no manual createOffer needed here.
}

async function handleCamSignal(sender, signal) {
    if (signal === 'CAM_STATE' || signal?.action === 'CAM_STATE') {
        const data = (typeof signal === 'string') ? JSON.parse(signal) : signal;
        peerCamActive[sender] = data.camOn;

        if (data.camOn) {
            const stream = remoteMediaStreams[sender];
            if (stream) addVideoBox(sender, stream, false);
        } else {
            document.getElementById(`cam-${sender}`)?.remove();
            if (camWrapper.children.length === 0) camWrapper.classList.add('hidden');
        }
        return;
    }

    const data = (typeof signal === 'string') ? JSON.parse(signal) : signal;
    let pc = camPeerConnections[sender];

    if (data.sdp) {
        if (data.sdp.type === 'offer') {
            pc = initCamPeerConnection(sender, true);
            const negState = getNegState(sender);
            negState.suppressNegotiation = true;
            if (data.camOn) peerCamActive[sender] = true;

            // Perfect Negotiation: if we're also mid-offer (glare), the polite
            // peer rolls back and accepts the incoming offer; the impolite
            // peer ignores the incoming one and lets its own offer win.
            const offerCollision = negState.makingOffer || pc.signalingState !== 'stable';
            negState.ignoreOffer = !negState.isPolite && offerCollision;
            if (negState.ignoreOffer) {
                console.warn(`[WebRTC] Ignoring colliding offer from ${sender} (we are impolite peer)`);
                return;
            }

            if (offerCollision) {
                await Promise.all([
                    pc.setLocalDescription({ type: 'rollback' }).catch(() => { }),
                ]);
            }

            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

            if (localCamStream) {
                await attachTrackToTransceiver(pc, 'video', localCamStream.getVideoTracks()[0]);
            }
            if (localMicStream && !isMicMuted) {
                await attachTrackToTransceiver(pc, 'audio', localMicStream.getAudioTracks()[0]);
            }

            if (pendingCamIceCandidates[sender]) {
                for (const candidate of pendingCamIceCandidates[sender]) {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => { });
                }
                delete pendingCamIceCandidates[sender];
            }

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendCamSignal(sender, { sdp: pc.localDescription, camOn: !!localCamStream, micOn: !!localMicStream && !isMicMuted });
            
            // Wait 100ms for the event loop to clear before allowing new negotiations
            setTimeout(() => { negState.suppressNegotiation = false; }, 100);

            if (data.camOn && remoteMediaStreams[sender]) addVideoBox(sender, remoteMediaStreams[sender], false);

        } else if (data.sdp.type === 'answer' && pc && pc.signalingState !== 'closed') {
            if (data.camOn) peerCamActive[sender] = true;
            if (pc.signalingState !== 'have-local-offer') {
                // We rolled back or already moved on - stale answer, ignore.
                return;
            }
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

            if (pendingCamIceCandidates[sender]) {
                for (const candidate of pendingCamIceCandidates[sender]) {
                    await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => { });
                }
                delete pendingCamIceCandidates[sender];
            }

            if (data.camOn && remoteMediaStreams[sender]) addVideoBox(sender, remoteMediaStreams[sender], false);
        }
    } else if (data.ice) {
        if (pc && pc.remoteDescription && pc.remoteDescription.type && pc.signalingState !== 'closed') {
            pc.addIceCandidate(new RTCIceCandidate(data.ice)).catch(e => console.error(e));
        } else {
            (pendingCamIceCandidates[sender] ||= []).push(data.ice);
        }
    }
}

// --- STANDARD ROOM LOGIC ---
async function enterRoom(isCreating) {
    const nameVal = document.getElementById('username').value.trim();
    const roomVal = document.getElementById('roomId').value.trim();

    if (!nameVal) return showToast("Please enter your name!", "bg-red");
    if (!roomVal) return showToast("Please enter a Room Code!", "bg-red");

    player.pause();
    player.removeAttribute('src');
    player.load();
    blocker.classList.remove('hidden');
    replayOverlay.classList.add('hidden');
    currentVideoDuration = 0;
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
        try { oldClient.disconnect(); } catch (error) { }
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
        resetCamPeerConnections();
        setConnectionStatus(true);
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('player-ui').classList.remove('hidden');
        document.querySelector('.room-back-btn')?.classList.add('hidden');
        document.getElementById('header-user-info').classList.remove('hidden');
        document.getElementById('display-username').innerText = username;
        document.getElementById('room-title').innerText = currentRoom.substring(roomPrefix.length);

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
        try { oldClient.disconnect(); } catch (error) { }
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
    if (currentRoom) exitRoom();
});

function exitRoom() {
    if (!currentRoom) return;
    isLeavingPage = true;
    pauseRoomPlayback();

    localCamStream?.getTracks().forEach(track => track.stop());
    localMicStream?.getTracks().forEach(track => track.stop());

    Object.keys(camPeerConnections).forEach(peer => teardownPeerConnection(peer));
    player.pause();
    player.removeAttribute('src');
    player.load();
    blocker.classList.remove('hidden');
    replayOverlay.classList.add('hidden');

    stompClient?.disconnect();
    sessionStorage.removeItem('syncPlayerRoom:' + roomMode);
    sessionStorage.removeItem('syncPlayerUsername:' + roomMode);
    window.location.reload();
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
        stompClient.send("/app/room/" + currentRoom + "/file-check", {}, JSON.stringify({ type: 'FILE_INFO', sender: username, duration: isNaN(dur) ? 0.0 : dur }));
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
    const wasAlreadyInRoom = roomUsers.includes(data.sender);
    if (data.activeUsers) {
        roomUsers = data.activeUsers;
        updateUserList(roomUsers);
    }

    if (data.type === 'WEBRTC') {
        if (data.action === 'CAM_STATE' && data.sender !== username) {
            handleCamSignal(data.sender, data).catch(() => { });
        } else if (data.target === username) {
            handleCamSignal(data.sender, data.text).catch(() => { });
        }
    }
    else if (data.type === 'ERROR_NAME_TAKEN' && data.sender === username && !hasJoined) {
        showToast("Username '" + username + "' is already in this room. Please choose another.", "bg-red");
        exitRoom();
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
            if (localCamStream || localMicStream) {
                roomUsers.filter(peer => peer !== username)
                    .forEach(peer => createCamPeerConnection(peer).catch(() => { }));
            }
        }
        checkOwnership(data.text);
        if (!wasAlreadyInRoom) {
            showToast(data.sender + " joined!", "bg-blue");
            addChatMessage("System", data.sender + " joined the room.");
        }

        if (data.sender !== username && (localCamStream || localMicStream)) {
            createCamPeerConnection(data.sender).catch(() => { });
        }
    }
    else if (data.type === 'LEAVE') {
        showToast(data.sender + " left.", "bg-red");
        addChatMessage("System", data.sender + " left the room.");

        teardownPeerConnection(data.sender);

        if (data.text && data.text !== "Left") {
            if (checkOwnership(data.text)) showToast("You are now the Host 👑", "bg-green");
        }
        if (data.activeUsers && data.activeUsers.length < 2) {
            player.pause();
            blocker.classList.remove('hidden');
        }
    }
    else if ((data.type === 'WAIT' || data.type === 'ERROR') && data.sender === 'Server') {
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
            if (data.action === 'PLAY') player.play().catch(e => console.log(e));
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
function showFloatingEmoji(char) { const el = document.createElement('div'); el.classList.add('floating-emoji'); el.innerText = char; el.style.left = (Math.random() * 80 + 10) + "%"; document.getElementById('hearts-container').appendChild(el); setTimeout(() => el.remove(), 3000); }

chatInput.addEventListener('input', () => stompClient.send("/app/room/" + currentRoom + "/typing", {}, JSON.stringify({ type: 'TYPING', sender: username })));
let typingHideTimeout;
function showTypingIndicator(senderName) {
    document.getElementById('typing-indicator').innerText = senderName + " is typing...";
    document.getElementById('typing-indicator').style.opacity = 1;
    clearTimeout(typingHideTimeout);
    typingHideTimeout = setTimeout(() => document.getElementById('typing-indicator').style.opacity = 0, 1500);
}
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