package com.syncvideo.sync_player;

import org.springframework.context.event.EventListener;
import org.springframework.http.ResponseEntity;
import org.springframework.messaging.handler.annotation.DestinationVariable;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.handler.annotation.SendTo;
import org.springframework.messaging.simp.SimpMessageHeaderAccessor;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

@RestController
public class SyncController {

    static class RoomInfo {
        Set<String> users = Collections.synchronizedSet(new LinkedHashSet<>());
        String owner = null;
        boolean isLocked = false;
    }

    private final Map<String, RoomInfo> rooms = new ConcurrentHashMap<>();
    private final Map<String, Map<String, Double>> roomVideoStates = new ConcurrentHashMap<>();
    private final Map<String, String> sessionRoomMap = new ConcurrentHashMap<>();
    private final Map<String, String> sessionUserMap = new ConcurrentHashMap<>();

    private final SimpMessagingTemplate messagingTemplate;

    public SyncController(SimpMessagingTemplate messagingTemplate) {
        this.messagingTemplate = messagingTemplate;
    }

    // --- 1. API ---
    @PostMapping("/api/create-room")
    public ResponseEntity<String> createRoom(@RequestBody String roomId) {
        if (rooms.containsKey(roomId))
            return ResponseEntity.status(409).body("Room already exists");

        rooms.put(roomId, new RoomInfo());

        System.out.println("✅ LOG: Room Created: " + roomId);
        System.out.println("📊 LOG: Active Rooms: " + rooms.size());

        return ResponseEntity.ok("Room Created");
    }

    @GetMapping("/api/room-status/{roomId}")
    public ResponseEntity<String> getRoomStatus(@PathVariable String roomId) {
        RoomInfo room = rooms.get(roomId);
        if (room == null)
            return ResponseEntity.ok("NOT_FOUND");
        if (room.isLocked)
            return ResponseEntity.ok("LOCKED");
        return ResponseEntity.ok("OPEN");
    }

    // --- 2. WEBSOCKET JOIN ---
    @MessageMapping("/room/{roomId}/join")
    public void joinRoom(@DestinationVariable String roomId, @Payload VideoMessage message,
            SimpMessageHeaderAccessor headerAccessor) {
        RoomInfo room = rooms.get(roomId);
        if (room == null) {
            room = new RoomInfo();
            rooms.put(roomId, room);
        }

        if (room.isLocked) {
            messagingTemplate.convertAndSend("/topic/room/" + roomId,
                    new VideoMessage("ERROR", message.getSender(), "Room is Locked", 0.0, 0.0));
            return;
        }
        if (room.users.contains(message.getSender())) {
            String staleSessionId = sessionUserMap.entrySet().stream()
                .filter(entry -> message.getSender().equals(entry.getValue())
                    && roomId.equals(sessionRoomMap.get(entry.getKey())))
                .map(Map.Entry::getKey)
                .findFirst()
                .orElse(null);
            if (staleSessionId == null) {
            messagingTemplate.convertAndSend("/topic/room/" + roomId,
                new VideoMessage("ERROR_NAME_TAKEN", message.getSender(), "Name taken", 0.0, 0.0));
            return;
            }
            sessionRoomMap.remove(staleSessionId);
            sessionUserMap.remove(staleSessionId);
            room.users.remove(message.getSender());
            roomVideoStates.getOrDefault(roomId, new ConcurrentHashMap<>()).remove(message.getSender());
        }
        if (room.users.isEmpty())
            room.owner = message.getSender();

        String sessionId = headerAccessor.getSessionId();
        sessionRoomMap.put(sessionId, roomId);
        sessionUserMap.put(sessionId, message.getSender());
        room.users.add(message.getSender());
        roomVideoStates.putIfAbsent(roomId, new ConcurrentHashMap<>());
        roomVideoStates.get(roomId).put(message.getSender(), 0.0);

        System.out.println("👥 LOG: Users in Room " + roomId + ": " + room.users);
        System.out.println("📊 LOG: Active Rooms: " + rooms.size());

        VideoMessage response = new VideoMessage("JOIN", message.getSender(), "Joined", 0.0, 0.0);
        response.setActiveUsers(new ArrayList<>(room.users));
        response.setText(room.owner);
        messagingTemplate.convertAndSend("/topic/room/" + roomId, response);
    }

    // --- 3. LOGIC HANDLERS ---
    @MessageMapping("/room/{roomId}/toggle-lock")
    public void toggleLock(@DestinationVariable String roomId, @Payload VideoMessage message) {
        RoomInfo room = rooms.get(roomId);
        if (room != null && message.getSender().equals(room.owner)) {
            room.isLocked = !room.isLocked;
            
            String status = room.isLocked ? "LOCKED" : "UNLOCKED";
            VideoMessage response = new VideoMessage("LOCK_UPDATE", "System", null, 0.0, room.isLocked ? 1.0 : 0.0);
            response.setText(status);
            
            messagingTemplate.convertAndSend("/topic/room/" + roomId, response);
        }
    }

    @MessageMapping("/room/{roomId}/file-check")
    public void checkFile(@DestinationVariable String roomId, @Payload VideoMessage message) {
        Double userDuration = message.getDuration();
        if (userDuration == null || userDuration <= 0)
            return;

        roomVideoStates.putIfAbsent(roomId, new ConcurrentHashMap<>());
        roomVideoStates.get(roomId).put(message.getSender(), userDuration);
        validateAndNotify(roomId);
    }

    // --- 4. REPLAY HANDLER ---
    @MessageMapping("/room/{roomId}/replay")
    public void replayVideo(@DestinationVariable String roomId, @Payload VideoMessage message) {
        boolean isSafeToReplay = validateFilesInternal(roomId);

        if (isSafeToReplay) {
            messagingTemplate.convertAndSend("/topic/room/" + roomId,
                    new VideoMessage("SYNC", message.getSender(), "REPLAY", 0.0, 0.0));
        } else {
            messagingTemplate.convertAndSend("/topic/room/" + roomId,
                    new VideoMessage("ERROR", "System", "File Mismatch during Replay", 0.0, 0.0));
        }
    }

    @MessageMapping("/room/{roomId}/reset")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage resetVideo(@Payload VideoMessage message) {
        return message;
    }

    private void validateAndNotify(String roomId) {
        RoomInfo room = rooms.get(roomId);
        if (room == null || room.users.size() < 2) {
            messagingTemplate.convertAndSend("/topic/room/" + roomId,
                    new VideoMessage("WAIT", "Server", "Waiting for friend...", 0.0, 0.0));
            return;
        }

        boolean allUsersSelected = room.users.stream()
            .allMatch(user -> roomVideoStates.get(roomId).getOrDefault(user, 0.0) > 0);
        boolean allMatch = validateFilesInternal(roomId);

        if (allUsersSelected && allMatch) {
            messagingTemplate.convertAndSend("/topic/room/" + roomId,
                new VideoMessage("READY", "Server", "Ready!", 0.0, 0.0));
        } else {
            String status = allUsersSelected ? "Mismatch!" : "Friend selecting video...";
            messagingTemplate.convertAndSend("/topic/room/" + roomId,
                new VideoMessage(allUsersSelected ? "ERROR" : "WAIT", "Server", status, 0.0, 0.0));
        }
    }

    private boolean validateFilesInternal(String roomId) {
        Map<String, Double> usersInRoom = roomVideoStates.get(roomId);
        if (usersInRoom == null)
            return false;

        Double referenceDuration = null;
        for (String user : rooms.get(roomId).users) {
            Double duration = usersInRoom.get(user);
            if (duration == null || duration <= 0)
                return false;
            if (referenceDuration == null)
                referenceDuration = duration;
            else if (Math.abs(referenceDuration - duration) > 2.0)
                return false;
        }
        return referenceDuration != null;
    }

    // --- 5. STANDARD SYNC ---
    @MessageMapping("/room/{roomId}/sync")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage syncVideo(@Payload VideoMessage message) {
        return message;
    }

    @MessageMapping("/room/{roomId}/chat")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage chat(@Payload VideoMessage message) {
        return message;
    }

    @MessageMapping("/room/{roomId}/reaction")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage reaction(@Payload VideoMessage message) {
        return message;
    }

    @MessageMapping("/room/{roomId}/typing")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage typing(@Payload VideoMessage message) {
        return message;
    }

    // --- 6. WEBSOCKET SIGNALING (DIRECT STREAM MODE) ---
    @MessageMapping("/room/{roomId}/webrtc")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage webrtcSignaling(@Payload VideoMessage message) {
        // Securely pass WebRTC negotiation data (Offers, Answers, ICE candidates)
        // between specific clients without storing them in DB/Memory.
        return message;
    }

    // --- 7. DISCONNECT HANDLER ---
    @EventListener
    public void handleDisconnect(SessionDisconnectEvent event) {
        String sessionId = event.getSessionId();
        String roomId = sessionRoomMap.get(sessionId);
        String username = sessionUserMap.get(sessionId);

        if (roomId != null && username != null) {
            RoomInfo room = rooms.get(roomId);
            if (room != null) {
                messagingTemplate.convertAndSend("/topic/room/" + roomId,
                        new VideoMessage("SYNC", username, "PAUSE", 0.0, 0.0));
                room.users.remove(username);
                if (roomVideoStates.containsKey(roomId))
                    roomVideoStates.get(roomId).remove(username);

                if (room.users.isEmpty()) {
                    rooms.remove(roomId);
                    roomVideoStates.remove(roomId);
                    System.out.println("❌ LOG: Room Destroyed: " + roomId);
                } else {
                    if (username.equals(room.owner)) {
                        String newOwner = room.users.iterator().next();
                        room.owner = newOwner;
                        VideoMessage msg = new VideoMessage("LEAVE", username, "Left", 0.0, 0.0);
                        msg.setActiveUsers(new ArrayList<>(room.users));
                        msg.setText(newOwner);
                        messagingTemplate.convertAndSend("/topic/room/" + roomId, msg);
                    } else {
                        VideoMessage msg = new VideoMessage("LEAVE", username, "Left", 0.0, 0.0);
                        msg.setActiveUsers(new ArrayList<>(room.users));
                        msg.setText(room.owner);
                        messagingTemplate.convertAndSend("/topic/room/" + roomId, msg);
                    }
                }
            }
            sessionRoomMap.remove(sessionId);
            sessionUserMap.remove(sessionId);
        }
    }
}