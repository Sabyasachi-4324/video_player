package com.syncvideo.sync_player;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

@JsonIgnoreProperties(ignoreUnknown = true)
public class VideoMessage {
    private String type;
    private String sender;
    private String action;
    private Double time = 0.0;
    private Double duration = 0.0;
    private List<String> activeUsers;
    private String text;
    private String target;
    private Boolean camOn;

    public VideoMessage() {
    }

    public VideoMessage(String type, String sender, String action, Double time, Double duration) {
        this.type = type;
        this.sender = sender;
        this.action = action;
        this.time = time;
        this.duration = duration;
    }

    public String getType() { return type; }
    public void setType(String type) { this.type = type; }

    public String getSender() { return sender; }
    public void setSender(String sender) { this.sender = sender; }

    public String getAction() { return action; }
    public void setAction(String action) { this.action = action; }

    public Double getTime() { return time; }
    public void setTime(Double time) { this.time = time; }

    public Double getDuration() { return duration; }
    public void setDuration(Double duration) { this.duration = duration; }

    public List<String> getActiveUsers() { return activeUsers; }
    public void setActiveUsers(List<String> activeUsers) { this.activeUsers = activeUsers; }

    public String getText() { return text; }
    public void setText(String text) { this.text = text; }

    public String getTarget() { return target; }
    public void setTarget(String target) { this.target = target; }

    public Boolean getCamOn() { return camOn; }
    public void setCamOn(Boolean camOn) { this.camOn = camOn; }
}