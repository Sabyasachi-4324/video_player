package com.syncvideo.sync_player;

import java.util.HashSet;
import java.util.Set;

public class RoomInfo {
    // Who is in the room?
    public Set<String> users = new HashSet<>();
    // What is the length of the video chosen by the Host (User 1)?
    public Double videoDuration = null;
    // Are both users ready?
    public boolean isReady = false;
}