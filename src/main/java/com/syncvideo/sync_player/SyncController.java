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
            System.out.println("⚠️ LOG: Attempt to create duplicate room: " + roomId);
            return ResponseEntity.status(409).body("Room already exists");
        }
        rooms.put(roomId, new RoomInfo());
        System.out.println("✅ LOG: Room Created: " + roomId + " | Total Rooms: " + rooms.size());
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
        
        RoomInfo room = rooms.get(roomId);
        if (room == null) {
            room = new RoomInfo();
            rooms.put(roomId, room);
        }

        if (room.users.contains(message.getSender())) {
            System.out.println("⚠️ LOG: User " + message.getSender() + " rejected (Name taken) in room " + roomId);
            return new VideoMessage("ERROR_NAME_TAKEN", message.getSender(), "Name already taken", 0.0, 0.0);
        }

        String sessionId = headerAccessor.getSessionId();
        sessionRoomMap.put(sessionId, roomId);
        sessionUserMap.put(sessionId, message.getSender());

        room.users.add(message.getSender());
        
        // --- PRINT LOG ---
        System.out.println("👤 LOG: " + message.getSender() + " joined " + roomId + " | Active Users: " + room.users);
        // ----------------

        roomVideoStates.putIfAbsent(roomId, new ConcurrentHashMap<>());
        roomVideoStates.get(roomId).put(message.getSender(), 0.0);

        VideoMessage response = new VideoMessage("JOIN", message.getSender(), "Joined", 0.0, 0.0);
        response.setActiveUsers(new ArrayList<>(room.users));
        return response;
    }

    // --- 3. FILE CHECK (With "Wait for Partner" Logic) ---
    @MessageMapping("/room/{roomId}/file-check")
    public void checkFile(@DestinationVariable String roomId, @Payload VideoMessage message) {
        Double userDuration = message.getDuration();
        if (userDuration == null || userDuration <= 0)
            return;

        // 1. Update this user's video state
        roomVideoStates.putIfAbsent(roomId, new ConcurrentHashMap<>());
        roomVideoStates.get(roomId).put(message.getSender(), userDuration);

        // 2. CHECK: Are there at least 2 people in the room?
        RoomInfo room = rooms.get(roomId);
        if (room == null || room.users.size() < 2) {
            // If I am alone, I must wait.
            messagingTemplate.convertAndSend("/topic/room/" + roomId,
                    new VideoMessage("WAIT", "Server", "Waiting for partner to join...", 0.0, 0.0));
            return;
        }

        // 3. Compare with ALL users
        Map<String, Double> usersInRoom = roomVideoStates.get(roomId);
        boolean allMatch = true;
        Double referenceDuration = null;
        int activeVideoUsers = 0;

        for (Double duration : usersInRoom.values()) {
            if (duration > 0) {
                activeVideoUsers++;
                if (referenceDuration == null) {
                    referenceDuration = duration;
                } else {
                    if (Math.abs(referenceDuration - duration) > 2.0) {
                        allMatch = false;
                        break;
                    }
                }
            }
        }

        // 4. Send Result
        if (activeVideoUsers > 0 && allMatch) {
            // Ensure EVERYONE in the room has uploaded a file
            if (activeVideoUsers < room.users.size()) {
                messagingTemplate.convertAndSend("/topic/room/" + roomId,
                        new VideoMessage("WAIT", "Server", "Partner is selecting video...", 0.0, 0.0));
            } else {
                messagingTemplate.convertAndSend("/topic/room/" + roomId,
                        new VideoMessage("READY", "Server", "Ready!", 0.0, 0.0));
            }
        } else {
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
            RoomInfo room = rooms.get(roomId);
            if (room != null) {
                room.users.remove(username);
                if (roomVideoStates.containsKey(roomId)) {
                    roomVideoStates.get(roomId).remove(username);
                }

                System.out.println("❌ LOG: " + username + " disconnected from " + roomId);

                if (room.users.isEmpty()) {
                    rooms.remove(roomId);
                    roomVideoStates.remove(roomId);
                    System.out.println("🗑️ LOG: Room " + roomId + " is empty and was DELETED.");
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