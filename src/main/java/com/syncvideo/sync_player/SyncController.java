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

    private static final Map<String, RoomInfo> rooms = new ConcurrentHashMap<>();
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

    // --- 2. JOIN ROOM ---
    @MessageMapping("/room/{roomId}/join")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage joinRoom(@DestinationVariable String roomId, @Payload VideoMessage message,
            SimpMessageHeaderAccessor headerAccessor) {
        String sessionId = headerAccessor.getSessionId();
        sessionRoomMap.put(sessionId, roomId);
        sessionUserMap.put(sessionId, message.getSender());

        RoomInfo room = rooms.get(roomId);
        if (room == null) {
            room = new RoomInfo();
            rooms.put(roomId, room);
        }

        room.users.add(message.getSender());

        VideoMessage response = new VideoMessage("JOIN", message.getSender(), "Joined", 0.0, 0.0);
        response.setActiveUsers(new ArrayList<>(room.users));
        return response;
    }

    // --- 3. FILE CHECK ---
    @MessageMapping("/room/{roomId}/file-check")
    public void checkFile(@DestinationVariable String roomId, @Payload VideoMessage message) {
        RoomInfo room = rooms.get(roomId);
        if (room == null)
            return;

        Double userDuration = message.getDuration();
        if (userDuration == null || userDuration <= 0)
            return;

        if (room.videoDuration == null) {
            room.videoDuration = userDuration;
            messagingTemplate.convertAndSend("/topic/room/" + roomId,
                    new VideoMessage("WAIT", "Server", "Waiting...", 0.0, 0.0));
        } else {
            double diff = Math.abs(room.videoDuration - userDuration);
            if (diff < 2.0) {
                room.isReady = true;
                messagingTemplate.convertAndSend("/topic/room/" + roomId,
                        new VideoMessage("READY", "Server", "Ready!", 0.0, 0.0));
            } else {
                messagingTemplate.convertAndSend("/topic/room/" + roomId,
                        new VideoMessage("ERROR", "Server", "Mismatch!", 0.0, 0.0));
            }
        }
    }

    // --- 4. SYNC VIDEO ---
    @MessageMapping("/room/{roomId}/sync")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage syncVideo(@DestinationVariable String roomId, VideoMessage message) {
        return message;
    }

    // --- 5. CHAT (THIS IS CRITICAL FOR CHAT TO WORK) ---
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

                if (room.users.isEmpty()) {
                    rooms.remove(roomId);
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

    // --- 7. HEART REACTION (New) ---
    @MessageMapping("/room/{roomId}/heart")
    @SendTo("/topic/room/{roomId}")
    public VideoMessage sendHeart(@DestinationVariable String roomId, VideoMessage message) {
        return message; // Simply bounce it to everyone
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
}