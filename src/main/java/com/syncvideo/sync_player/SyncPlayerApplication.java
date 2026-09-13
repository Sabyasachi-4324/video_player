package com.syncvideo.sync_player;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class SyncPlayerApplication {

	public static void main(String[] args) {
		SpringApplication.run(SyncPlayerApplication.class, args);
	}

}