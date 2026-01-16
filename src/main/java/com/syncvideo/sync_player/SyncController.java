package com.syncvideo.sync_player;

import org.springframework.context.event.EventListener;
import org.springframework.http.ResponseEntity;
import org.springframework.messaging.handler.annotation.DestinationVariable;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.handler.annotation.SendTo;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import java.util.ArrayList;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Controller
@RestController
public class SyncController {

    // Existing Room Info (Users list)
    private static final Map<String, RoomInfo> rooms = new ConcurrentHashMap<>();

    // NEW: Stores Video Duration for EVERY User independently
    // Structure: RoomID -> { Username -> Duration }
    private final Map<String, Map<String, Double>> roomVideoStates = new ConcurrentHashMap<>();

    private static final Map<String, String> sessionRoomMap = new ConcurrentHashMap<>();
    private static final Map<String, String> sessionUserMap = new ConcurrentHashMap<>();

    private final SimpMessagingTemplate messagingTemplate;

    public SyncController(SimpMessagingTemplate messagingTemplate) {
        this.messagingTemplate = messagingTemplate;
    }

    // --- 1. CREATE ROOM ---
    @PostMapping("/api/create-room")
    public ResponseEntity<String> createRoom(@RequestBody String roomId) {
        if (rooms.containsKey(roomId)) {
            return ResponseEntity.status(409).body("Room already exists");
        }
        rooms.put(roomId, new RoomInfo());
        return ResponseEntity.ok("Room Created");
    }

    @GetMapping("/api/check-room/{roomId}")
    public boolean checkRoom(@PathVariable String roomId) {
        return rooms.containsKey(roomId);
    }

    // --- 2. JOIN ROOM (With Unique Name Check) ---
    @MessageMapping("/room/{roomId}/join")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage joinRoom(@DestinationVariable String roomId, @Payload VideoMessage message,
            SimpMessageHeaderAccessor headerAccessor) {

        // 1. Get or Create Room
        RoomInfo room = rooms.get(roomId);
        if (room == null) {
            room = new RoomInfo();
            rooms.put(roomId, room);
        }

        // 2. CHECK IF NAME EXISTS (New Logic)
        // If the list of users already contains this name, reject it.
        if (room.users.contains(message.getSender())) {
            return new VideoMessage("ERROR_NAME_TAKEN", message.getSender(), "Name already taken", 0.0, 0.0);
        }

        // 3. If unique, add user and session
        String sessionId = headerAccessor.getSessionId();
        sessionRoomMap.put(sessionId, roomId);
        sessionUserMap.put(sessionId, message.getSender());

        room.users.add(message.getSender());

        // Initialize video state
        roomVideoStates.putIfAbsent(roomId, new ConcurrentHashMap<>());
        roomVideoStates.get(roomId).put(message.getSender(), 0.0);

        VideoMessage response = new VideoMessage("JOIN", message.getSender(), "Joined", 0.0, 0.0);
        response.setActiveUsers(new ArrayList<>(room.users));
        return response;
    }

    // --- 3. FILE CHECK (CRITICAL FIX) ---
    @MessageMapping("/room/{roomId}/file-check")
    public void checkFile(@DestinationVariable String roomId, @Payload VideoMessage message) {
        Double userDuration = message.getDuration();
        if (userDuration == null || userDuration <= 0)
            return;

        // 1. Ensure storage exists
        roomVideoStates.putIfAbsent(roomId, new ConcurrentHashMap<>());

        // 2. ALWAYS update this specific user's duration
        // This ensures that even if it's a mismatch now, the server REMEMBERS the new
        // file.
        roomVideoStates.get(roomId).put(message.getSender(), userDuration);

        // 3. Compare with ALL other users in the room
        Map<String, Double> usersInRoom = roomVideoStates.get(roomId);
        boolean allMatch = true;
        Double referenceDuration = null;

        // We only check users who have actually uploaded something (duration > 0)
        int activeVideoUsers = 0;

        for (Double duration : usersInRoom.values()) {
            if (duration > 0) {
                activeVideoUsers++;
                if (referenceDuration == null) {
                    referenceDuration = duration;
                } else {
                    // Allow 2 seconds difference
                    double diff = Math.abs(referenceDuration - duration);
                    if (diff > 2.0) {
                        allMatch = false;
                        break;
                    }
                }
            }
        }

        // 4. Send Result
        // If only 1 person has uploaded, we WAIT. If mismatch, ERROR. If match, READY.
        if (activeVideoUsers > 0 && allMatch) {
            // If there are multiple users, ensure they all match before sending READY
            if (activeVideoUsers < rooms.get(roomId).users.size()) {
                messagingTemplate.convertAndSend("/topic/room/" + roomId,
                        new VideoMessage("WAIT", "Server", "Waiting for partner...", 0.0, 0.0));
            } else {
                messagingTemplate.convertAndSend("/topic/room/" + roomId,
                        new VideoMessage("READY", "Server", "Ready!", 0.0, 0.0));
            }
        } else {
            // Mismatch detected
            messagingTemplate.convertAndSend("/topic/room/" + roomId,
                    new VideoMessage("ERROR", "Server", "Mismatch!", 0.0, 0.0));
        }
    }

    // --- 4. SYNC VIDEO ---
    @MessageMapping("/room/{roomId}/sync")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage syncVideo(@DestinationVariable String roomId, VideoMessage message) {
        return message;
    }

    // --- 5. CHAT ---
    @MessageMapping("/room/{roomId}/chat")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage sendChat(@DestinationVariable String roomId, VideoMessage message) {
        return message;
    }

    // --- 6. DISCONNECT ---
    @EventListener
    public void handleDisconnect(SessionDisconnectEvent event) {
        String sessionId = event.getSessionId();
        String roomId = sessionRoomMap.get(sessionId);
        String username = sessionUserMap.get(sessionId);

        if (roomId != null && username != null) {
            // Remove user from Room Info
            RoomInfo room = rooms.get(roomId);
            if (room != null) {
                room.users.remove(username);

                // Remove user from Video States (So they don't cause mismatches while gone)
                if (roomVideoStates.containsKey(roomId)) {
                    roomVideoStates.get(roomId).remove(username);
                }

                if (room.users.isEmpty()) {
                    rooms.remove(roomId);
                    roomVideoStates.remove(roomId); // Clean up memory
                } else {
                    VideoMessage leaveMsg = new VideoMessage("LEAVE", username, "Left", 0.0, 0.0);
                    leaveMsg.setActiveUsers(new ArrayList<>(room.users));
                    messagingTemplate.convertAndSend("/topic/room/" + roomId, leaveMsg);
                }
            }
            sessionRoomMap.remove(sessionId);
            sessionUserMap.remove(sessionId);
        }
    }

    // --- 7. HEART REACTION ---
    @MessageMapping("/room/{roomId}/heart")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage sendHeart(@DestinationVariable String roomId, VideoMessage message) {
        return message;
    }

    // --- 8. EMOJI REACTION ---
    @MessageMapping("/room/{roomId}/reaction")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage sendReaction(@DestinationVariable String roomId, VideoMessage message) {
        return message;
    }

    // --- 9. TYPING INDICATOR ---
    @MessageMapping("/room/{roomId}/typing")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage sendTyping(@DestinationVariable String roomId, VideoMessage message) {
        return message;
    }

    // --- 10. RESET / VIDEO ENDED ---
    @MessageMapping("/room/{roomId}/reset")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage resetVideo(@DestinationVariable String roomId, VideoMessage message) {
        // Optional: Clear the stored video state so the comparison starts fresh
        // roomVideoStates.get(roomId).clear();

        // Broadcast "RESET" to everyone
        return new VideoMessage("RESET", message.getSender(), "Video Ended", 0.0, 0.0);
    }
}