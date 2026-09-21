package com.syncvideo.sync_player;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketTransportRegistration;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    // Safely overrides the native WebSocket container limits (Tomcat/Jetty) to 5MB
    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(5 * 1024 * 1024);   // 5 MB
        container.setMaxBinaryMessageBufferSize(5 * 1024 * 1024); // 5 MB
        return container;
    }

    @Override
    public void configureWebSocketTransport(WebSocketTransportRegistration registration) {
        // Increases Spring STOMP's internal message size limits to 5MB
        registration.setMessageSizeLimit(5 * 1024 * 1024);
        registration.setSendBufferSizeLimit(5 * 1024 * 1024);
        registration.setSendTimeLimit(20000);
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry config) {
        config.enableSimpleBroker("/topic");
        config.setApplicationDestinationPrefixes("/app");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws-video").withSockJS();
    }
}